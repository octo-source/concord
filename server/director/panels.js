// Panel architecture recommendation: the Director proposes 3–5 jurors from
// DISJOINT model families plus an aggregation rule, choosing only from the
// models the project's privacy mode actually permits (the candidate list is
// built through registry.getAdapter, so strict mode offers local families
// only). The proposal is validated against the registry catalogs — a juror
// must name a real model, and family overlap is rejected outright: same-family
// jurors share failure modes and manufacture fake consensus.
import { ConcordError } from "../core/errors.js";
import { getAdapter } from "../providers/registry.js";
import { callDirector } from "./director.js";
// Juror budgets come from the compiler's CLASS_MAX_TOKENS (single owner — see
// the reasoning-model thinking-token rationale there; a stale private copy
// here is what truncated Gemini Flash juror calls in the field).
import { CLASS_MAX_TOKENS } from "./compiler.js";
import { panelPrompt, PANEL_SCHEMA, defaultTemplate, AGGREGATIONS } from "./prompts.js";

const PROVIDER_NAMES = ["anthropic", "openai", "openrouter", "ollama", "mock"];

// Rough cost per 1k units for the candidate list (mean unit ~500 chars plus a
// mid-class template, 256 output tokens/call) — enough signal for the
// Director to reason about budget without a full preflight.
function estPer1kUSD(pricing, templateChars = 1200, unitChars = 500, outTokens = 256) {
  const inTokens = ((templateChars + unitChars) / 3.6) * 1000;
  const usd =
    (inTokens / 1e6) * (pricing.inUSDper1M ?? 0) +
    ((outTokens * 1000) / 1e6) * (pricing.outUSDper1M ?? 0);
  return Math.round(usd * 100) / 100;
}

// Privacy-filtered candidate models across every reachable provider.
// PRIVACY_BLOCKED → provider silently excluded (that is the mode working);
// unreachable catalogs (e.g. Ollama not running) are skipped likewise.
export async function gatherCandidates(project) {
  const candidates = [];
  for (const name of PROVIDER_NAMES) {
    let adapter;
    try {
      ({ adapter } = getAdapter(project, name));
    } catch (err) {
      if (err?.code === "PRIVACY_BLOCKED") continue;
      throw err;
    }
    let cat;
    try {
      cat = await adapter.catalog();
    } catch {
      continue; // offline/unreachable catalog → no candidates from it
    }
    for (const m of cat) {
      candidates.push({
        provider: name,
        id: m.id,
        family: m.family,
        snapshot: m.snapshot ?? m.id,
        pricing: m.pricing ?? { inUSDper1M: 0, outUSDper1M: 0 },
        estPer1kUSD: estPer1kUSD(m.pricing ?? {}),
      });
    }
  }
  return candidates;
}

// recommendPanel(project, construct, {budgetUSDper1k?, outputSchemaFor?})
// → {payload: PanelPayload, rationale, families, candidates, authoredBy, humanTouched}
export async function recommendPanel(project, construct, opts = {}) {
  const { budgetUSDper1k = null } = opts;
  const candidates = await gatherCandidates(project);
  if (candidates.length === 0) {
    throw new ConcordError(
      "CONFIG_MISSING",
      "no worker models are available under this project's privacy mode — add a provider key or start a local backend",
      {},
    );
  }

  const { system, user } = panelPrompt({
    construct,
    candidates,
    budgetUSDper1k,
    privacyMode: project.privacyMode,
  });
  const res = await callDirector(project, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    schema: PANEL_SCHEMA,
    // thinking tokens bill against max_tokens on reasoning-class Directors
    // — keep at the reasoning-tolerant floor (≥2048)
    maxTokens: 2048,
  });
  const out = res.json;

  // ---- validation against the registry catalogs
  if (out.jurors.length < 3 || out.jurors.length > 5) {
    throw new ConcordError(
      "VALIDATION",
      `a panel needs 3–5 jurors; the Director proposed ${out.jurors.length}`,
      { jurors: out.jurors.length },
    );
  }
  if (!AGGREGATIONS.includes(out.aggregation)) {
    throw new ConcordError("VALIDATION", `unknown aggregation rule "${out.aggregation}"`, {
      aggregation: out.aggregation,
    });
  }
  const byProviderModel = new Map(candidates.map((c) => [`${c.provider}/${c.id}`, c]));
  const families = [];
  const resolved = out.jurors.map((j) => {
    const cand = byProviderModel.get(`${j.provider}/${j.model}`);
    if (!cand) {
      throw new ConcordError(
        "VALIDATION",
        `proposed juror ${j.provider}/${j.model} is not in the available model catalog`,
        { juror: j },
      );
    }
    families.push(cand.family);
    return { juror: j, cand };
  });
  const familySet = new Set(families);
  if (familySet.size !== families.length) {
    throw new ConcordError(
      "VALIDATION",
      `panel jurors must come from disjoint model families; got ${families.join(", ")} — same-family jurors share failure modes and fake consensus`,
      { families },
    );
  }

  // outputSchemaFor is the pinned sibling (server/instruments/judge.js),
  // injectable so tests do not depend on the sibling file existing.
  let outputSchemaFor = opts.outputSchemaFor;
  if (!outputSchemaFor) ({ outputSchemaFor } = await import("../instruments/judge.js"));
  const schema = outputSchemaFor(construct);

  const jurors = resolved.map(({ juror, cand }) => ({
    provider: juror.provider,
    model: juror.model,
    snapshot: juror.snapshot ?? cand.snapshot,
    params: { temperature: 0, maxTokens: CLASS_MAX_TOKENS[juror.workerClass] },
    promptTemplate: defaultTemplate(juror.workerClass),
    schema,
    rationaleFirst: true,
    workerClass: juror.workerClass,
  }));
  const payload = {
    jurors,
    aggregation: out.aggregation,
    ...(out.weights !== undefined ? { weights: out.weights } : {}),
  };
  return {
    payload,
    rationale: out.rationale,
    families,
    candidates,
    authoredBy: "director",
    humanTouched: false,
  };
}
