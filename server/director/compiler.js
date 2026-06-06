// Instrument compilation: construct → judge instrument with a
// Director-authored prompt template targeted at a worker class, and
// construct → seeded dictionary instrument.
//
// Authoring vs guaranteeing: the Director writes the template's intelligence
// (task framing, decision procedure, class-appropriate scaffolding); the
// compiler then ENFORCES the structural invariants deterministically — the
// four template slots must exist, and small-class templates must end with the
// strict output constraints. A frontier model that forgets a slot once in ten
// thousand compiles must not be able to ship a broken instrument.
//
// Compiled instruments are PROPOSALS (not persisted); acceptInstrument() is
// the explicit persistence step (push onto project.instruments + ledger
// `instrument.compiled`).
import { ConcordError } from "../core/errors.js";
import { createInstrument } from "../core/objects.js";
import { updateProject, projectDir } from "../core/store.js";
import * as ledger from "../core/ledger.js";
import { compile as compileDictionary } from "../instruments/dictionary.js";
import { callDirector } from "./director.js";
import {
  compilePrompt, COMPILE_SCHEMA, dictionarySeedPrompt, DICTIONARY_SEED_SCHEMA,
  TEMPLATE_SLOTS, SLOT_SECTIONS, SMALL_STRICT_BLOCK, RATIONALE_FIRST_LINE,
  defaultTemplate, WORKER_CLASSES,
} from "./prompts.js";

// Per-class output budgets for compiled judge instruments. These must cover
// the rationale-first JSON PLUS reasoning-model thinking tokens, which bill
// against max_tokens on most stacks (OpenRouter/Gemini/OpenAI reasoning
// tiers). The old budgets (frontier 512 / mid 384 / small 256) fit the JSON
// alone, so reasoning-class workers truncated MOST calls nondeterministically
// and the engine quarantined them silently (June 2026 field bug). judgeUnit's
// per-call truncation retry (ONE doubling, capped at 8192) covers the tail of
// unusually long thinking; these floors cover the typical case.
const CLASS_MAX_TOKENS = { frontier: 2048, mid: 1536, small: 1024 };

// outputSchemaFor lives in the sibling server/instruments/judge.js (pinned:
// outputSchemaFor(construct) → OutputSchema). It is injectable so Director
// tests do not depend on the sibling file existing; production callers omit
// it and get the real module via dynamic import at call time.
async function resolveOutputSchemaFor(injected) {
  if (injected) return injected;
  const mod = await import("../instruments/judge.js");
  return mod.outputSchemaFor;
}

// Deterministic post-processing: guarantee the slots and the class scaffolding
// regardless of what the Director (or a researcher using the raw escape
// hatch) wrote.
export function enforceTemplateScaffolding(template, workerClass) {
  let t = String(template ?? "").trim();
  if (!t) t = defaultTemplate(workerClass);
  for (const slot of TEMPLATE_SLOTS) {
    if (!t.includes(slot)) t = `${t}\n\n${SLOT_SECTIONS[slot]}`;
  }
  const needsRationaleLine = workerClass !== "frontier" && !/rationale/i.test(t);
  if (needsRationaleLine) t = `${t}\n\n${RATIONALE_FIRST_LINE}`;
  if (workerClass === "small" && !t.includes(SMALL_STRICT_BLOCK)) {
    t = `${t}\n\n${SMALL_STRICT_BLOCK}`;
  }
  return t;
}

// compileInstrument(project, construct, {workerClass, provider, model,
// snapshot, promptTemplate?, outputSchemaFor?}) → Instrument (kind "judge").
//
// promptTemplate (optional) is the raw escape hatch: a caller-supplied
// template skips the Director call (the scaffolding guarantees still apply).
// Such an instrument is authored by whoever supplied the template — "human"
// unless stated otherwise — because artifact attribution must stay honest.
export async function compileInstrument(project, construct, opts = {}) {
  const { workerClass, provider, model, snapshot = null, promptTemplate, authoredBy } = opts;
  if (!WORKER_CLASSES.includes(workerClass)) {
    throw new ConcordError("VALIDATION", `workerClass must be one of ${WORKER_CLASSES.join(", ")}; got "${workerClass}"`, { workerClass });
  }
  if (!provider || !model) {
    throw new ConcordError("VALIDATION", "compileInstrument requires {provider, model} for the worker", { provider, model });
  }
  const outputSchemaFor = await resolveOutputSchemaFor(opts.outputSchemaFor);

  let template;
  let note;
  let author;
  if (promptTemplate !== undefined) {
    template = enforceTemplateScaffolding(promptTemplate, workerClass);
    note = "caller-supplied template (raw escape hatch)";
    author = authoredBy ?? "human";
  } else {
    const { system, user } = compilePrompt(construct, workerClass);
    const res = await callDirector(project, {
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      schema: COMPILE_SCHEMA,
      // thinking tokens bill against max_tokens on reasoning-class Directors
      // — keep at the reasoning-tolerant floor (≥2048)
      maxTokens: 2048,
    });
    template = enforceTemplateScaffolding(res.json.promptTemplate, workerClass);
    note = res.json.note;
    author = authoredBy ?? "director";
  }

  const payload = {
    provider,
    model,
    snapshot,
    params: { temperature: 0, maxTokens: CLASS_MAX_TOKENS[workerClass] },
    promptTemplate: template,
    schema: outputSchemaFor(construct),
    rationaleFirst: true,
    workerClass,
  };
  const instrument = createInstrument({
    constructId: construct.id,
    kind: "judge",
    name: `${construct.name} — ${workerClass} judge`,
    payload,
    authoredBy: author,
    humanTouched: author === "human",
  });
  instrument.compileNote = note;
  return instrument;
}

// seedDictionary(project, construct, sampleUnits) → {instrument, dropped}
// Director proposes term lists; every term is validated through the dictionary
// engine's own compiler — invalid terms (and reserved category names) are
// dropped with a researcher-facing note rather than poisoning the payload.
export async function seedDictionary(project, construct, sampleUnits) {
  const { system, user } = dictionarySeedPrompt({ construct, sampleUnits: sampleUnits ?? [] });
  const res = await callDirector(project, {
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    schema: DICTIONARY_SEED_SCHEMA,
    // thinking tokens bill against max_tokens on reasoning-class Directors
    // — keep at the reasoning-tolerant floor (≥2048)
    maxTokens: 2048,
  });

  const dropped = [];
  const categories = [];
  for (const cat of res.json.categories) {
    if (cat.name === "empty" || cat.name.startsWith("NOT_")) {
      dropped.push({ category: cat.name, term: null, reason: `category name "${cat.name}" is reserved by the dictionary engine` });
      continue;
    }
    const terms = [];
    for (const raw of cat.terms) {
      const term = String(raw).trim();
      if (!term) continue;
      // validate the single term through the real compiler so the acceptance
      // rule is exactly the engine's rule, not a reimplementation
      try {
        compileDictionary({
          categories: [{ name: cat.name, terms: [{ term }] }],
          negation: { enabled: false, window: 3 },
          scoring: "percentOfWords",
        });
        terms.push({ term });
      } catch (err) {
        dropped.push({ category: cat.name, term, reason: err?.message ?? String(err) });
      }
    }
    if (terms.length > 0) categories.push({ name: cat.name, terms });
    else dropped.push({ category: cat.name, term: null, reason: "category had no valid terms left" });
  }
  if (categories.length === 0) {
    throw new ConcordError("VALIDATION", "the Director's proposed dictionary contained no valid categories", { dropped });
  }

  const payload = {
    categories,
    negation: { enabled: true, window: 3 },
    scoring: "percentOfWords",
  };
  compileDictionary(payload); // final whole-payload validation
  const instrument = createInstrument({
    constructId: construct.id,
    kind: "dictionary",
    name: `${construct.name} — dictionary`,
    payload,
    authoredBy: "director",
    humanTouched: false,
  });
  instrument.compileNote = res.json.note ?? "";
  return { instrument, dropped };
}

// acceptInstrument(project, instrument) → instrumentId
// Explicit persistence: push onto project.instruments + ledger
// `instrument.compiled`. Actor "human" — acceptance is the human act; the
// payload records who authored the artifact.
export async function acceptInstrument(project, instrument) {
  if (!instrument?.id || !instrument?.payload) {
    throw new ConcordError("VALIDATION", "acceptInstrument needs a compiled instrument", {});
  }
  await updateProject(project.slug, (p) => {
    if (p.instruments.some((i) => i.id === instrument.id)) {
      throw new ConcordError("VALIDATION", `instrument ${instrument.id} already exists on the project`, { instrumentId: instrument.id });
    }
    p.instruments.push(instrument);
  });
  await ledger.append(projectDir(project.slug), "human", "instrument.compiled", {
    instrumentId: instrument.id,
    constructId: instrument.constructId,
  }, {
    kind: instrument.kind,
    versionHash: instrument.versionHash,
    workerClass: instrument.payload.workerClass ?? null,
    provider: instrument.payload.provider ?? null,
    model: instrument.payload.model ?? null,
    authoredBy: instrument.authoredBy,
  });
  return instrument.id;
}
