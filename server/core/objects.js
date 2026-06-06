// Constructors + validators for Concord's core object shapes. Constructors
// copy known fields only, fill defaults, and throw ConcordError("VALIDATION")
// on bad enums/shapes. Instruments are content-addressed: versionHash =
// sha256(canonical(payload)); frozen instruments are deep-frozen and can only
// evolve by forking (lineage via parentVersion).
import { ConcordError } from "./errors.js";
import { canonical, sha256, newId } from "./ids.js";

export const PRIVACY_MODES = ["open", "no-training", "strict"];
export const CONSTRUCT_TYPES = ["binary", "nominal", "ordinal", "continuous", "multilabel", "extraction"];
export const EXAMPLE_KINDS = ["positive", "negative", "nearmiss"];
export const INSTRUMENT_KINDS = ["dictionary", "rule", "judge", "panel", "human"];
export const EVIDENCE_LEVELS = ["exploratory", "stabilized", "calibrated", "corrected"];
export const GOLDSET_TIERS = ["gold", "silver"];
export const GOLDSET_DESIGNS = ["srs", "stratified", "uncertainty"];
export const GOLDSET_STATUSES = ["sampling", "coding", "adjudicating", "complete"];
export const RUN_STATUSES = ["pending", "running", "paused", "complete", "aborted", "failed"];
export const ANALYSIS_KINDS = ["descriptive", "crosstab", "model", "triangulation", "subgroup"];
export const AUTHORS = ["human", "director"];

function fail(message, details = {}) {
  throw new ConcordError("VALIDATION", message, details);
}

function reqString(v, field) {
  if (typeof v !== "string" || v.length === 0) fail(`${field} must be a non-empty string`, { field, value: v });
  return v;
}

function oneOf(v, list, field) {
  if (!list.includes(v)) fail(`${field} must be one of: ${list.join(", ")}`, { field, value: v });
  return v;
}

function plainObject(v, field) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) fail(`${field} must be an object`, { field, value: v });
  return v;
}

function stringArray(v, field) {
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) fail(`${field} must be an array of strings`, { field });
  return v;
}

// Windows reserved device names make fs calls misbehave when used as a
// directory name; suffix them rather than reject (the user typed "Con
// Survey", not a syscall).
const RESERVED_SLUGS = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

function slugify(name) {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return RESERVED_SLUGS.has(s) ? `${s}-project` : s;
}

// ---------------------------------------------------------------- Project

export function createProject(input = {}) {
  reqString(input.name, "name");
  const slug = input.slug ?? slugify(input.name);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) fail("slug must be lowercase letters, digits, hyphens", { field: "slug", value: slug });
  const privacyMode = oneOf(input.privacyMode ?? "open", PRIVACY_MODES, "privacyMode");
  const budget = {
    capUSD: input.budget?.capUSD ?? null,
    spentUSD: input.budget?.spentUSD ?? 0,
  };
  if (budget.capUSD !== null && (typeof budget.capUSD !== "number" || budget.capUSD < 0)) fail("budget.capUSD must be null or a number >= 0", { field: "budget.capUSD" });
  if (typeof budget.spentUSD !== "number" || budget.spentUSD < 0) fail("budget.spentUSD must be a number >= 0", { field: "budget.spentUSD" });
  let director = input.director ?? null;
  if (director !== null) {
    plainObject(director, "director");
    director = {
      provider: reqString(director.provider, "director.provider"),
      model: reqString(director.model, "director.model"),
      snapshot: director.snapshot ?? null,
      // Optional researcher customization appended to every Director system
      // prompt (also the test seam for MockModel handler markers).
      ...(typeof director.systemSuffix === "string" && director.systemSuffix !== ""
        ? { systemSuffix: director.systemSuffix }
        : {}),
    };
  }
  return {
    id: input.id ?? newId("p"),
    name: input.name,
    slug,
    createdAt: input.createdAt ?? new Date().toISOString(),
    privacyMode,
    budget,
    director,
    corpora: input.corpora ?? [],
    constructs: input.constructs ?? [],
    instruments: input.instruments ?? [],
    goldsets: input.goldsets ?? [],
    analyses: input.analyses ?? [],
    briefs: input.briefs ?? [],
    plans: input.plans ?? [], // Question Bar plan artifacts
    runs: input.runs ?? [],
    // The report canvas is a persisted project artifact from birth: a list of
    // layout blocks (chart|table|quote|text|methods-excerpt) plus a stamp of
    // when it last changed. Exports default their layout to these blocks.
    report: {
      blocks: input.report?.blocks ?? [],
      updatedAt: input.report?.updatedAt ?? null,
    },
  };
}

// ---------------------------------------------------------------- Construct

export function createConstruct(input = {}) {
  reqString(input.name, "name");
  oneOf(input.type, CONSTRUCT_TYPES, "type");
  const out = {
    id: input.id ?? newId("c"),
    name: input.name,
    type: input.type,
    definition: input.definition ?? "",
    criteria: {
      include: stringArray(input.criteria?.include ?? [], "criteria.include"),
      exclude: stringArray(input.criteria?.exclude ?? [], "criteria.exclude"),
    },
    edgeCases: stringArray(input.edgeCases ?? [], "edgeCases"),
    examples: (input.examples ?? []).map((ex, i) => {
      plainObject(ex, `examples[${i}]`);
      reqString(ex.text, `examples[${i}].text`);
      if (ex.label === undefined) fail(`examples[${i}].label is required`, { field: "examples" });
      oneOf(ex.kind, EXAMPLE_KINDS, `examples[${i}].kind`);
      return { text: ex.text, label: ex.label, kind: ex.kind };
    }),
    authoredBy: oneOf(input.authoredBy ?? "human", AUTHORS, "authoredBy"),
    humanTouched: input.humanTouched ?? (input.authoredBy ?? "human") === "human",
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  if (input.categories !== undefined) {
    if (!Array.isArray(input.categories) || input.categories.length === 0) fail("categories must be a non-empty array", { field: "categories" });
    out.categories = input.categories.map((c, i) => {
      plainObject(c, `categories[${i}]`);
      if (c.value === undefined) fail(`categories[${i}].value is required`, { field: "categories" });
      reqString(c.label, `categories[${i}].label`);
      return c.anchor !== undefined ? { value: c.value, label: c.label, anchor: c.anchor } : { value: c.value, label: c.label };
    });
  }
  if (input.scale !== undefined) {
    plainObject(input.scale, "scale");
    const { min, max } = input.scale;
    if (typeof min !== "number" || typeof max !== "number" || !(min < max)) fail("scale requires numbers min < max", { field: "scale", value: input.scale });
    out.scale = { min, max };
  }
  // Provenance: the corpus id whose sample fed a Director draft. Optional —
  // only stamped when a registered corpus actually backed the proposal, never
  // guessed (a hand-authored construct carries no draftedFrom).
  if (input.draftedFrom !== undefined) out.draftedFrom = reqString(input.draftedFrom, "draftedFrom");
  return out;
}

// ---------------------------------------------------------------- Instrument

export function instrumentVersionHash(payload) {
  return sha256(canonical(payload));
}

export function createInstrument(input = {}) {
  reqString(input.constructId, "constructId");
  oneOf(input.kind, INSTRUMENT_KINDS, "kind");
  plainObject(input.payload, "payload");
  // Constructors create NEW things: a frozen instrument can only come from
  // freeze() (which mints the certificate) or rehydrateProject() on load.
  if (input.frozen) fail("createInstrument cannot create a frozen instrument — use freeze()", { field: "frozen" });
  const out = {
    id: input.id ?? newId("inst"),
    constructId: input.constructId,
    kind: input.kind,
    name: input.name ?? input.kind,
    level: oneOf(input.level ?? "exploratory", EVIDENCE_LEVELS, "level"),
    version: input.version ?? 1,
    versionHash: instrumentVersionHash(input.payload),
    frozen: false,
    payload: input.payload,
    authoredBy: oneOf(input.authoredBy ?? "human", AUTHORS, "authoredBy"),
    humanTouched: input.humanTouched ?? (input.authoredBy ?? "human") === "human",
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  if (!Number.isInteger(out.version) || out.version < 1) fail("version must be an integer >= 1", { field: "version", value: out.version });
  if (input.parentVersion !== undefined) out.parentVersion = input.parentVersion;
  if (input.certificate !== undefined) out.certificate = input.certificate;
  if (input.stability !== undefined) out.stability = input.stability;
  if (input.silver !== undefined) out.silver = input.silver;
  return out;
}

// Unfrozen: mutate in place (bump version, swap payload, recompute hash).
// Frozen: never mutate — return a fresh fork carrying lineage.
export function versionInstrument(inst, newPayload) {
  plainObject(newPayload, "payload");
  if (inst.frozen) {
    return createInstrument({
      constructId: inst.constructId,
      kind: inst.kind,
      name: inst.name,
      payload: newPayload,
      parentVersion: inst.versionHash,
      authoredBy: inst.authoredBy,
      humanTouched: inst.humanTouched,
    });
  }
  inst.payload = newPayload;
  inst.version += 1;
  inst.versionHash = instrumentVersionHash(newPayload);
  // The payload changed, so every piece of accumulated evidence is stale:
  // back to exploratory, and stability/silver/certificate cannot survive
  // (a certificate can only exist on a frozen instrument).
  inst.level = "exploratory";
  delete inst.stability;
  delete inst.silver;
  delete inst.certificate;
  return inst;
}

// Freeze BEFORE recursing: marks the node visited, so cyclic payloads
// terminate instead of overflowing the stack.
function deepFreeze(obj) {
  Object.freeze(obj);
  for (const v of Object.values(obj)) {
    if (v !== null && typeof v === "object" && !Object.isFrozen(v)) deepFreeze(v);
  }
  return obj;
}

export function freeze(inst, certificate) {
  if (inst.frozen) fail("instrument is already frozen", { id: inst.id });
  plainObject(certificate, "certificate");
  inst.frozen = true;
  inst.certificate = certificate;
  return deepFreeze(inst);
}

// Re-arm invariants on a project parsed back from disk: JSON.parse returns
// plain mutable objects, so frozen instruments must be deep-frozen again (and
// enums sanity-checked cheaply). store.loadProject calls this before returning.
export function rehydrateProject(project) {
  for (const inst of project?.instruments ?? []) {
    oneOf(inst.kind, INSTRUMENT_KINDS, "kind");
    oneOf(inst.level, EVIDENCE_LEVELS, "level");
    if (inst.frozen === true) deepFreeze(inst);
  }
  return project;
}

// ---------------------------------------------------------------- GoldSet

export function createGoldSet(input = {}) {
  reqString(input.constructId, "constructId");
  if (input.name !== undefined && typeof input.name !== "string") fail("name must be a string", { field: "name", value: input.name });
  const out = {
    id: input.id ?? newId("gs"),
    constructId: input.constructId,
    // A human-facing label; "" by default (routes auto-name "Gold — <construct>").
    name: input.name ?? "",
    tier: oneOf(input.tier ?? "gold", GOLDSET_TIERS, "tier"),
    design: oneOf(input.design ?? "srs", GOLDSET_DESIGNS, "design"),
    sample: (input.sample ?? []).map((s, i) => {
      plainObject(s, `sample[${i}]`);
      reqString(s.unitId, `sample[${i}].unitId`);
      if (typeof s.pi !== "number" || !(s.pi > 0) || s.pi > 1) fail(`sample[${i}].pi must be a number in (0, 1]`, { field: "sample", value: s.pi });
      return { unitId: s.unitId, pi: s.pi };
    }),
    coders: input.coders ?? [],
    status: oneOf(input.status ?? "sampling", GOLDSET_STATUSES, "status"),
  };
  if (input.strata !== undefined) out.strata = input.strata;
  if (input.humanAgreement !== undefined) out.humanAgreement = input.humanAgreement;
  if (input.adjudicated !== undefined) out.adjudicated = input.adjudicated;
  return out;
}

// ---------------------------------------------------------------- Run

export function createRun(input = {}) {
  reqString(input.instrumentId, "instrumentId");
  reqString(input.versionHash, "versionHash");
  reqString(input.corpusId, "corpusId");
  reqString(input.provider, "provider");
  reqString(input.model, "model");
  if (input.name !== undefined && typeof input.name !== "string") fail("name must be a string", { field: "name", value: input.name });
  const out = {
    id: input.id ?? newId("run"),
    instrumentId: input.instrumentId,
    versionHash: input.versionHash,
    corpusId: input.corpusId,
    // A human-facing label; "" by default (routes auto-name "<instrument> · <corpus>").
    name: input.name ?? "",
    status: oneOf(input.status ?? "pending", RUN_STATUSES, "status"),
    checkpoint: { done: input.checkpoint?.done ?? 0, total: input.checkpoint?.total ?? 0 },
    cost: {
      estUSD: input.cost?.estUSD ?? 0,
      actualUSD: input.cost?.actualUSD ?? 0,
      inputTokens: input.cost?.inputTokens ?? 0,
      outputTokens: input.cost?.outputTokens ?? 0,
    },
    escalation: { count: input.escalation?.count ?? 0, directorModel: input.escalation?.directorModel ?? null },
    quarantine: input.quarantine ?? [],
    startedAt: input.startedAt ?? null,
    finishedAt: input.finishedAt ?? null,
    provider: input.provider,
    model: input.model,
    snapshot: input.snapshot ?? null,
    pinned: input.pinned ?? false,
  };
  if (typeof out.pinned !== "boolean") fail("pinned must be a boolean", { field: "pinned" });
  if (input.unitFilter !== undefined) out.unitFilter = input.unitFilter;
  return out;
}

// ---------------------------------------------------------------- Analysis

export function createAnalysis(input = {}) {
  oneOf(input.kind, ANALYSIS_KINDS, "kind");
  plainObject(input.spec, "spec");
  return {
    id: input.id ?? newId("an"),
    kind: input.kind,
    spec: input.spec,
    results: input.results ?? null,
    level: oneOf(input.level ?? "exploratory", EVIDENCE_LEVELS, "level"),
    evidence: { cells: input.evidence?.cells ?? {} },
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}
