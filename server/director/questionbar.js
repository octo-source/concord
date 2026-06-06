// The Question Bar: chat as compiler, never oracle. A plain-language question
// compiles into a VISIBLE plan — drafted constructs, instrument specs, a cost
// and time estimate, and the analysis that will answer the question. Nothing
// runs until the researcher approves; approval materializes the constructs
// and instruments (persist + ledger) and hands the ids back for the routes to
// preflight.
//
// Plans persist on project.plans (additive Project field approved in review;
// initialized lazily here so bundles created before the field exist keep
// loading). Ledger events `plan.compiled` / `plan.approved` are the two
// taxonomy additions approved for this flow.
import { ConcordError } from "../core/errors.js";
import { createConstruct, createAnalysis } from "../core/objects.js";
import { newId } from "../core/ids.js";
import { updateProject, loadProject, projectDir } from "../core/store.js";
import * as ledger from "../core/ledger.js";
import { estimateRun } from "../providers/costs.js";
import { callDirector, readCorpusUnits, seededSample } from "./director.js";
import { detect } from "../ingest/mapping.js";
import { questionPrompt, QUESTION_PLAN_SCHEMA, defaultTemplate } from "./prompts.js";
// CLASS_MAX_TOKENS (single owner: compiler.js — reasoning-model thinking
// tokens bill against max_tokens) keeps plan cost estimates honest about the
// output budget the compiled instruments will actually carry.
import { compileInstrument, acceptInstrument, CLASS_MAX_TOKENS } from "./compiler.js";
import { gatherCandidates } from "./panels.js";

// compileQuestion(project, corpusId, question) → plan artifact
export async function compileQuestion(project, corpusId, question) {
  if (typeof question !== "string" || !question.trim()) {
    throw new ConcordError("VALIDATION", "the question bar needs a question", {});
  }
  const { meta, units } = await readCorpusUnits(project, corpusId);
  const sampleUnits = seededSample(units, Math.min(12, units.length), `qbar|${corpusId}`);
  const { columns } = detect(units.map((u) => u.meta ?? {}));
  const metaColumns = columns.filter((c) => c.role === "categorical").map((c) => c.name);
  const candidates = await gatherCandidates(project);
  if (candidates.length === 0) {
    throw new ConcordError("CONFIG_MISSING", "no worker models are available under this project's privacy mode — add a provider key or start a local backend", {});
  }

  const { system, user } = questionPrompt({
    question,
    corpusName: meta.name ?? corpusId,
    unitCount: units.length,
    sampleUnits,
    metaColumns,
    candidates,
  });
  const res = await callDirector(project, {
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    schema: QUESTION_PLAN_SCHEMA,
    maxTokens: 4096,
  });
  const out = res.json;

  // constructs get real ids NOW so the plan's instrument specs can reference
  // them and approval is a pure materialization (no re-drafting drift)
  const constructs = out.constructs.map((entry) => createConstruct({
    name: entry.name,
    type: entry.type,
    definition: entry.definition,
    criteria: entry.criteria,
    edgeCases: entry.edgeCases,
    examples: entry.examples,
    ...(entry.categories !== undefined ? { categories: entry.categories } : {}),
    ...(entry.scale !== undefined ? { scale: entry.scale } : {}),
    authoredBy: "director",
    humanTouched: false,
  }));
  const byName = new Map(constructs.map((c) => [c.name, c]));

  const byProviderModel = new Map(candidates.map((c) => [`${c.provider}/${c.id}`, c]));
  const instruments = out.instruments.map((spec) => {
    const construct = byName.get(spec.construct);
    if (!construct) {
      throw new ConcordError("VALIDATION", `plan instrument references unknown construct "${spec.construct}"`, { construct: spec.construct });
    }
    const cand = byProviderModel.get(`${spec.provider}/${spec.model}`);
    if (!cand) {
      throw new ConcordError("VALIDATION", `plan instrument names ${spec.provider}/${spec.model}, which is not in the available model catalog`, { spec });
    }
    return {
      constructId: construct.id,
      constructName: construct.name,
      workerClass: spec.workerClass,
      provider: spec.provider,
      model: spec.model,
      snapshot: spec.snapshot ?? cand.snapshot,
    };
  });

  // estimate: one run per instrument over the whole corpus; template length
  // approximated by the class default frame plus the codebook the slots carry
  const texts = units.map((u) => u.text ?? "");
  const perInstrument = instruments.map((spec) => {
    const cand = byProviderModel.get(`${spec.provider}/${spec.model}`);
    const construct = constructs.find((c) => c.id === spec.constructId);
    const codebookChars = (construct.definition.length)
      + construct.criteria.include.join(" ").length
      + construct.criteria.exclude.join(" ").length
      + construct.examples.reduce((n, ex) => n + ex.text.length, 0);
    const est = estimateRun({
      units: texts,
      template: defaultTemplate(spec.workerClass) + " ".repeat(codebookChars),
      maxTokens: CLASS_MAX_TOKENS[spec.workerClass],
      pricing: cand.pricing,
    });
    return { constructId: spec.constructId, model: spec.model, ...est };
  });
  const estimate = {
    usd: Math.round(perInstrument.reduce((n, e) => n + e.estUSD, 0) * 1e6) / 1e6,
    etaMin: Math.max(0.1, Math.round(perInstrument.reduce((n, e) => n + e.etaMinutes, 0) * 10) / 10),
    calls: perInstrument.reduce((n, e) => n + e.calls, 0),
    inputTokens: perInstrument.reduce((n, e) => n + e.inputTokens, 0),
    outputTokens: perInstrument.reduce((n, e) => n + e.outputTokens, 0),
    perInstrument,
  };

  // the analysis must be materializable today, not at approval time
  createAnalysis({ kind: out.analysis.kind, spec: out.analysis.spec });
  const analysis = { kind: out.analysis.kind, spec: out.analysis.spec, annotation: out.analysis.annotation };

  const plan = {
    planId: newId("plan"),
    question,
    corpusId,
    createdAt: new Date().toISOString(),
    status: "proposed",
    constructs,
    instruments,
    estimate,
    analysis,
    authoredBy: "director",
    humanTouched: false,
  };

  await updateProject(project.slug, (p) => {
    p.plans ??= [];
    p.plans.push(plan);
  });
  await ledger.append(projectDir(project.slug), "director", "plan.compiled", {
    planId: plan.planId, corpusId,
  }, {
    question,
    constructs: constructs.length,
    instruments: instruments.length,
    estUSD: estimate.usd,
    analysisKind: analysis.kind,
  });
  return plan;
}

// approvePlan(project, planId, {outputSchemaFor?}) → {planId, constructIds, instrumentIds}
// Materializes the plan: constructs persist + ledger construct.created each;
// instruments are compiled by the Director (full compile call per instrument)
// and persist + ledger instrument.compiled; the plan flips to "approved" with
// a plan.approved event. Routes then preflight/start runs with the ids.
export async function approvePlan(project, planId, opts = {}) {
  let plan = (project.plans ?? []).find((p) => p.planId === planId);
  if (!plan) {
    // the caller's in-memory project may predate compileQuestion — check disk
    project = await loadProject(project.slug);
    plan = (project.plans ?? []).find((p) => p.planId === planId);
    if (!plan) throw new ConcordError("NOT_FOUND", `plan '${planId}' not found on this project`, { planId });
  }
  if (plan.status !== "proposed") {
    throw new ConcordError("VALIDATION", `plan '${planId}' is already ${plan.status}`, { planId, status: plan.status });
  }

  // compile instruments BEFORE the mutation (Director calls must not run
  // inside the project lock)
  const compiled = [];
  for (const spec of plan.instruments) {
    const construct = plan.constructs.find((c) => c.id === spec.constructId);
    const instrument = await compileInstrument(project, construct, {
      workerClass: spec.workerClass,
      provider: spec.provider,
      model: spec.model,
      snapshot: spec.snapshot,
      ...(opts.outputSchemaFor ? { outputSchemaFor: opts.outputSchemaFor } : {}),
    });
    compiled.push(instrument);
  }

  await updateProject(project.slug, (p) => {
    const stored = (p.plans ?? []).find((x) => x.planId === planId);
    if (!stored) throw new ConcordError("NOT_FOUND", `plan '${planId}' not found on this project`, { planId });
    if (stored.status !== "proposed") {
      throw new ConcordError("VALIDATION", `plan '${planId}' is already ${stored.status}`, { planId, status: stored.status });
    }
    for (const c of plan.constructs) {
      if (!p.constructs.some((x) => x.id === c.id)) p.constructs.push(c);
    }
    stored.status = "approved";
    stored.approvedAt = new Date().toISOString();
  });

  const pdir = projectDir(project.slug);
  for (const c of plan.constructs) {
    await ledger.append(pdir, "human", "construct.created", { constructId: c.id }, {
      name: c.name, type: c.type, authoredBy: c.authoredBy, via: planId,
    });
  }
  const instrumentIds = [];
  for (const instrument of compiled) {
    await acceptInstrument(project, instrument); // persists + ledgers instrument.compiled
    instrumentIds.push(instrument.id);
  }
  await ledger.append(pdir, "human", "plan.approved", { planId, corpusId: plan.corpusId }, {
    constructIds: plan.constructs.map((c) => c.id),
    instrumentIds,
  });
  return { planId, constructIds: plan.constructs.map((c) => c.id), instrumentIds };
}
