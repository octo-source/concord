// Every prompt the Director ever receives, in one reviewable place.
//
// Each template is an exported function returning {system, user} message
// content, paired with the STRICT JSON response schema the call must satisfy
// (additionalProperties:false on every object node — Director outputs are
// artifacts, and artifacts have shapes). These templates run against real
// frontier models in production; they are written to be unambiguous,
// evidence-demanding, and schema-exact. MockModel handlers script them in
// tests and keyless mode.
//
// House rules encoded below:
//   - The Director designs and audits; it NEVER bulk-codes a corpus.
//   - Every claim must be anchored to supplied unit ids; inventing ids,
//     quotes, or facts is the cardinal sin.
//   - Responses are a single JSON object matching the schema. No prose.
import { CONSTRUCT_TYPES, EXAMPLE_KINDS } from "../core/objects.js";
import { ConcordError } from "../core/errors.js";

export const WORKER_CLASSES = ["frontier", "mid", "small"];

// Shared identity for every Director call. callDirector appends the
// project-level systemSuffix (researcher customization; handler markers in
// tests) after whatever template-specific system text is supplied.
export const DIRECTOR_PREAMBLE =
  "You are the Director of a Concord measurement study: a senior research methodologist " +
  "who designs qualitative measurement instruments for a human researcher. You draft; the " +
  "researcher decides. Everything you produce is an editable artifact that will be reviewed, " +
  "so write it to be checked: ground every claim in the material supplied in this conversation, " +
  "cite unit ids exactly as given, and never invent ids, quotations, statistics, or facts. " +
  "You never bulk-code data — workers do that; you design, calibrate, and audit their instruments. " +
  "Respond with a single JSON object that conforms exactly to the response schema. No surrounding prose.";

// ---------------------------------------------------------------- rendering

const truncate = (text, max = 700) => {
  const t = String(text ?? "");
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
};

export function renderUnit(u, { maxChars = 700 } = {}) {
  const metaEntries = Object.entries(u.meta ?? {}).slice(0, 6);
  const meta = metaEntries.length ? ` (${metaEntries.map(([k, v]) => `${k}=${v}`).join(", ")})` : "";
  return `--- unit ${u.id}${meta} ---\n${truncate(u.text, maxChars)}`;
}

export function renderUnits(units, opts) {
  return units.map((u) => renderUnit(u, opts)).join("\n\n");
}

// The codebook as workers and the Director both see it. Kept in one place so
// silver labeling, escalation review, and compilation read the same entry.
export function codebookBlock(construct) {
  const lines = [
    `Construct: ${construct.name} (type: ${construct.type})`,
    `Definition: ${construct.definition || "(none provided)"}`,
  ];
  if (construct.categories?.length) {
    lines.push("Categories:");
    for (const c of construct.categories) {
      lines.push(`  - ${c.value}: ${c.label}${c.anchor ? ` — ${c.anchor}` : ""}`);
    }
  }
  if (construct.scale) lines.push(`Scale: ${construct.scale.min} to ${construct.scale.max}`);
  if (construct.criteria?.include?.length) {
    lines.push("Include when:");
    for (const s of construct.criteria.include) lines.push(`  - ${s}`);
  }
  if (construct.criteria?.exclude?.length) {
    lines.push("Exclude when:");
    for (const s of construct.criteria.exclude) lines.push(`  - ${s}`);
  }
  if (construct.edgeCases?.length) {
    lines.push("Edge cases:");
    for (const s of construct.edgeCases) lines.push(`  - ${s}`);
  }
  if (construct.examples?.length) {
    lines.push("Worked examples:");
    for (const ex of construct.examples) {
      lines.push(`  - [${ex.kind} → ${JSON.stringify(ex.label)}] "${truncate(ex.text, 240)}"`);
    }
  }
  return lines.join("\n");
}

// ------------------------------------------------- construct → JSON schemas

// The strict JSON schema for one judgment of `construct` — used when the
// DIRECTOR itself labels (silver, escalation second opinions). Rationale comes
// first: stating the evidence before the verdict measurably disciplines the
// verdict. The sibling judge module derives the workers' schema from
// outputSchemaFor(construct); this one is the Director's own.
export function judgeResponseSchema(construct) {
  const properties = {
    rationale: { type: "string" },
  };
  let label;
  const enumOf = () => {
    if (!construct.categories?.length) return null;
    return construct.categories.map((c) => String(c.value));
  };
  switch (construct.type) {
    case "binary":
      label = { type: "string", enum: enumOf() ?? ["yes", "no"] };
      break;
    case "nominal":
    case "ordinal": {
      const options = enumOf();
      if (!options) {
        throw new ConcordError("VALIDATION", `construct "${construct.name}" is ${construct.type} but declares no categories`, { constructId: construct.id });
      }
      label = { type: "string", enum: options };
      break;
    }
    case "multilabel": {
      const options = enumOf();
      if (!options) {
        throw new ConcordError("VALIDATION", `construct "${construct.name}" is multilabel but declares no categories`, { constructId: construct.id });
      }
      label = { type: "array", items: { type: "string", enum: options } };
      break;
    }
    case "continuous":
      label = { type: "number", minimum: construct.scale?.min ?? 0, maximum: construct.scale?.max ?? 100 };
      break;
    case "extraction":
      label = { type: "array", items: { type: "string" } };
      break;
    default:
      throw new ConcordError("VALIDATION", `unknown construct type "${construct.type}"`, { type: construct.type });
  }
  properties.label = label;
  properties.confidence = { type: "number", minimum: 0, maximum: 1 };
  return {
    type: "object",
    additionalProperties: false,
    required: ["rationale", "label", "confidence"],
    properties,
  };
}

// Second-opinion schema: a judgment plus a one-line reason addressed to the
// researcher explaining why the worker's call was kept or overturned.
export function escalationSchema(construct) {
  const base = judgeResponseSchema(construct);
  return {
    ...base,
    required: [...base.required, "reason"],
    properties: { ...base.properties, reason: { type: "string" } },
  };
}

// ---------------------------------------------------------------- the brief

export const BRIEF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["unitOfAnalysis", "paragraphs", "themes", "redFlags", "suggestedQuestions"],
  properties: {
    unitOfAnalysis: { type: "string" },
    paragraphs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["md", "refs"],
        properties: {
          md: { type: "string" },
          refs: { type: "array", items: { type: "string" } },
        },
      },
    },
    themes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "definition", "quoteRefs"],
        properties: {
          name: { type: "string" },
          definition: { type: "string" },
          quoteRefs: { type: "array", items: { type: "string" } },
        },
      },
    },
    redFlags: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "detail", "refs"],
        properties: {
          kind: { type: "string", enum: ["duplicates", "bots", "pii", "junk", "language", "coverage", "other"] },
          detail: { type: "string" },
          refs: { type: "array", items: { type: "string" } },
        },
      },
    },
    suggestedQuestions: { type: "array", items: { type: "string" } },
  },
};

export function briefPrompt({ projectName, corpusName, unitCount, sample, metaSummary }) {
  const system =
    `${DIRECTOR_PREAMBLE}\n\n` +
    "For this task you are writing a Corpus Brief: the first-read memo a meticulous research assistant " +
    "hands a principal investigator after a day with new data. Voice: direct, concrete, evidence-anchored. " +
    "Quote sparingly and exactly. Where the data is thin or messy, say so plainly — flattery about data quality wastes the reader's time.";
  const user =
    `Project: ${projectName}\nCorpus: ${corpusName} — ${unitCount} units in total.\n` +
    `You are shown a stratified sample (by text length and metadata) of ${sample.length} units below. ` +
    `Metadata columns observed: ${metaSummary || "(none)"}.\n\n` +
    "Write the Corpus Brief as JSON with:\n" +
    `- "unitOfAnalysis": one sentence naming the most defensible unit of analysis you observe (e.g. "one survey response per row") and why.\n` +
    `- "paragraphs": 4-8 short markdown paragraphs that read in order as one memo: what this data is, who is speaking, ` +
    "what they talk about, how length/quality/language vary, and which metadata relationships look worth probing. " +
    'EVERY paragraph must carry "refs": the unit ids (verbatim from the sample below) that ground its claims — at least one per paragraph, ' +
    "and only ids you were actually shown. A paragraph whose claim you cannot anchor to a shown unit id does not belong in the brief.\n" +
    `- "themes": 3-8 candidate themes, each with a one-sentence working definition and "quoteRefs" listing AT LEAST THREE unit ids ` +
    "whose text genuinely instantiates the theme. These become draft constructs, so define them tightly enough to code against.\n" +
    `- "redFlags": red flags — data-quality problems you can see in the sample: duplicates, bot-like repetition, junk rows, personally identifying ` +
    'information, unexpected languages, coverage gaps. Each flag needs "refs" pointing at offending units (empty only for corpus-level observations).\n' +
    `- "suggestedQuestions": 2-5 plain-language research questions this corpus could answer, phrased as a researcher would type them.\n\n` +
    "Cite unit ids exactly as printed (the token after 'unit', e.g. u_ab12cd34ef567890). Never cite ids you were not shown, " +
    "never invent or paraphrase-then-quote text, and never fabricate counts you cannot tally from the sample.\n\n" +
    `SAMPLE UNITS:\n\n${renderUnits(sample)}`;
  return { system, user };
}

// ------------------------------------------------------- construct drafting

const constructEntrySchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "type", "definition", "criteria", "edgeCases", "examples"],
  properties: {
    name: { type: "string" },
    type: { type: "string", enum: CONSTRUCT_TYPES },
    definition: { type: "string" },
    criteria: {
      type: "object",
      additionalProperties: false,
      required: ["include", "exclude"],
      properties: {
        include: { type: "array", items: { type: "string" } },
        exclude: { type: "array", items: { type: "string" } },
      },
    },
    edgeCases: { type: "array", items: { type: "string" } },
    examples: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "label", "kind"],
        properties: {
          text: { type: "string" },
          label: { type: ["string", "number"] },
          kind: { type: "string", enum: EXAMPLE_KINDS },
        },
      },
    },
    categories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["value", "label"],
        properties: {
          value: { type: "string" },
          label: { type: "string" },
          anchor: { type: "string" },
        },
      },
    },
    scale: {
      type: "object",
      additionalProperties: false,
      required: ["min", "max"],
      properties: { min: { type: "number" }, max: { type: "number" } },
    },
  },
};

export const CONSTRUCTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["constructs"],
  properties: { constructs: { type: "array", items: constructEntrySchema } },
};

const CODEBOOK_CRAFT_BASE =
  "Codebook craft rules:\n" +
  "- DEFINITION: one or two sentences a trained coder could apply without you in the room. Name the concept, not its symptoms.\n" +
  "- INCLUDE/EXCLUDE criteria: concrete, observable decision rules. 'Mentions pay amount, raises, or fairness of compensation' — not 'is about money'.\n" +
  "- EDGE CASES: the judgments coders will actually argue about (sarcasm, mixed sentiment, hearsay, past-vs-present). State the ruling.\n" +
  "- For binary constructs, declare categories yes/no. For nominal/ordinal/multilabel, declare every category with a short anchor. " +
  "For continuous, declare the scale.\n" +
  "- Names: short noun phrases; definitions never circular (the name must not be doing the defining).";

const CODEBOOK_CRAFT =
  `${CODEBOOK_CRAFT_BASE}\n` +
  "- WORKED EXAMPLES: choose them ONLY from the sample units supplied in this message, quoting the text verbatim (you may trim, never alter words). " +
  "For each construct aim for one positive, one negative, and one near-miss (kind: \"nearmiss\") — the near-miss is the most instructive: " +
  "something that looks codable but is excluded, with the label it actually deserves.";

const CODEBOOK_CRAFT_IMPORT =
  `${CODEBOOK_CRAFT_BASE}\n` +
  "- WORKED EXAMPLES: carry over the document's own examples verbatim with your best-judgment labels and kinds; " +
  "where the document supplies none, leave examples empty — never invent any.";

export function constructDraftPrompt({ themesOrQuestion, sampleUnits, existingConstructNames = [] }) {
  const system =
    `${DIRECTOR_PREAMBLE}\n\n` +
    "For this task you are drafting formal codebook entries (constructs) that human coders and model judges will both apply. " +
    "A weak definition costs days of recoding; write entries you would be willing to defend in a methods review.";
  const source = Array.isArray(themesOrQuestion)
    ? `Draft one construct per theme below:\n${themesOrQuestion.map((t) => `- ${typeof t === "string" ? t : `${t.name}: ${t.definition ?? ""}`}`).join("\n")}`
    : `Draft the construct(s) needed to answer this research question:\n"${themesOrQuestion}"`;
  const user =
    `${source}\n\n` +
    (existingConstructNames.length ? `Constructs that already exist (do not duplicate them): ${existingConstructNames.join(", ")}.\n\n` : "") +
    `${CODEBOOK_CRAFT}\n\n` +
    "Worked examples must be mined verbatim from these sample units — never invented, never edited beyond trimming:\n\n" +
    `${renderUnits(sampleUnits)}`;
  return { system, user };
}

export function codebookImportPrompt({ docText, fileName }) {
  const system =
    `${DIRECTOR_PREAMBLE}\n\n` +
    "For this task you are structuring a legacy codebook document into formal construct entries. " +
    "Preserve the original author's intent and wording wherever it is usable; tighten only what is too vague to code against. " +
    "Do not add constructs the document does not contain.";
  const user =
    `The researcher imported a legacy codebook${fileName ? ` ("${fileName}")` : ""}. Its extracted text follows. ` +
    "Convert each codable concept it defines into a construct entry. Do not add constructs the document does not define.\n\n" +
    `${CODEBOOK_CRAFT_IMPORT}\n\n` +
    `DOCUMENT TEXT:\n\n${truncate(docText, 24_000)}`;
  return { system, user };
}

// ------------------------------------------------------- inductive taxonomy

export const TAXONOMY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["themes"],
  properties: {
    themes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "definition", "quoteRefs"],
        properties: {
          name: { type: "string" },
          definition: { type: "string" },
          quoteRefs: { type: "array", items: { type: "string" } },
        },
      },
    },
    note: { type: "string" },
  },
};

export function inductivePrompt({ sampleUnits }) {
  const system =
    `${DIRECTOR_PREAMBLE}\n\n` +
    "For this task you are doing inductive theme discovery. Be explicit with yourself about what this is: " +
    "HYPOTHESIS GENERATION from a sample, not measurement. The output will be labeled as hypothesis, " +
    "reviewed by the researcher, and only becomes a construct after human acceptance and calibration.";
  const user =
    `Read the ${sampleUnits.length} sampled units below and propose the smallest taxonomy of themes that covers what people are actually saying ` +
    "(typically 4-10 themes). For each theme: a short name, a one-sentence working definition tight enough to code against, " +
    'and "quoteRefs" — AT LEAST THREE unit ids (verbatim from below) whose text genuinely instantiates the theme. ' +
    "A theme you cannot anchor in three real units is not yet a theme; leave it out. " +
    "Prefer themes about what is said over themes about how it is phrased, and do not force coverage: " +
    "it is fine for units to fit no theme.\n\n" +
    `SAMPLE UNITS:\n\n${renderUnits(sampleUnits)}`;
  return { system, user };
}

// ------------------------------------------------------ instrument compiler

export const COMPILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["promptTemplate", "note"],
  properties: {
    promptTemplate: { type: "string" },
    note: { type: "string" },
  },
};

export const REWRITE_SCHEMA = COMPILE_SCHEMA;

// Deterministic scaffolding shared with compiler.js. The slot block is what
// the sibling judge.assemble fills at run time.
export const TEMPLATE_SLOTS = ["{{definition}}", "{{criteria}}", "{{examples}}", "{{unit}}"];

export const SLOT_SECTIONS = {
  "{{definition}}": "Construct definition:\n{{definition}}",
  "{{criteria}}": "Coding criteria (include / exclude):\n{{criteria}}",
  "{{examples}}": "Worked examples:\n{{examples}}",
  "{{unit}}": "Unit to code:\n<unit>{{unit}}</unit>",
};

export const RATIONALE_FIRST_LINE =
  "Write your rationale FIRST, quoting the unit's exact words that drive your decision; then give the label; then your confidence from 0 to 1.";

export const SMALL_STRICT_BLOCK =
  "Respond ONLY with a single JSON object that matches the output schema exactly. " +
  "No prose before or after the JSON. No code fences. No keys beyond the schema. " +
  "If you are uncertain, still choose the single best label and lower your confidence — never refuse, never emit null.";

const CLASS_GUIDANCE = {
  frontier:
    "Target worker: a FRONTIER model. Keep the template lean — a capable model follows a crisp rubric better than a padded one. " +
    "State the task in two or three sentences, rely on the {{definition}} and {{criteria}} slots for the rubric, " +
    "and do not restate the codebook in your own words. The worker will see the worked examples supplied through the {{examples}} slot; " +
    "you do not need to tell it how to use them.",
  mid:
    "Target worker: a MID-TIER model. Give it a clear decision procedure: read the unit, check the include criteria, check the exclude criteria, decide. " +
    "Direct it to study the two worked examples it will see in the {{examples}} slot and to mirror their reasoning style. " +
    "Spell out the rationale-first discipline explicitly.",
  small:
    "Target worker: a SMALL model. Be maximally concrete and constraining. Use short imperative sentences. " +
    "Give a tight rubric restated as a checklist, direct it to imitate the four worked examples it will see in the {{examples}} slot, " +
    "and close with strict output constraints: it must respond ONLY with JSON matching the schema — no prose, no code fences, no extra keys. " +
    "Small models drift; every sentence in the template should remove a degree of freedom.",
};

export function compilePrompt(construct, workerClass) {
  const system =
    `${DIRECTOR_PREAMBLE}\n\n` +
    "For this task you are compiling a judging prompt template: the standing instructions one worker model will receive once per unit, " +
    "thousands of times. Every word is multiplied by the corpus size, so make every word earn its place.";
  const user =
    `Write the prompt template for a worker that will code the construct below, one unit per call.\n\n` +
    `${CLASS_GUIDANCE[workerClass]}\n\n` +
    "Template mechanics (hard requirements):\n" +
    `- The template MUST contain these literal slots, which Concord fills at run time: {{definition}}, {{criteria}}, {{examples}}, {{unit}}.\n` +
    "- Wrap the unit slot as <unit>{{unit}}</unit> so the worker can always find the text to code.\n" +
    `- The worker answers in JSON with rationale first, then label, then confidence. Say so: "${RATIONALE_FIRST_LINE}"\n` +
    "- Do not bake the construct's text into the template — the slots carry it. The template is the frame, the codebook is the picture.\n" +
    '- "note": one line for the researcher describing the design choice you made for this worker class.\n\n' +
    `THE CONSTRUCT BEING COMPILED (for your understanding — it flows in through the slots):\n${codebookBlock(construct)}`;
  return { system, user };
}

// ------------------------------------------------ confusion-driven rewrite

export function confusionRewritePrompt({ construct, currentTemplate, confusionSummary, agreement }) {
  const system =
    `${DIRECTOR_PREAMBLE}\n\n` +
    "For this task you are revising a worker's prompt template after watching it disagree with your own silver labels. " +
    "Diagnose the confusion pattern, then change the SMALLEST thing that fixes it. Wholesale rewrites destroy what already works.";
  const user =
    `The worker currently agrees with the silver labels on ${(agreement * 100).toFixed(1)}% of the calibration sample. ` +
    "Its most frequent confusions, with real example units, are:\n\n" +
    `${confusionSummary}\n\n` +
    `CURRENT TEMPLATE:\n${currentTemplate}\n\n` +
    "Rewrite the template to correct these specific confusions. Hard requirements:\n" +
    "- Keep all four literal slots: {{definition}}, {{criteria}}, {{examples}}, {{unit}} (the unit wrapped as <unit>{{unit}}</unit>).\n" +
    "- Keep the rationale-first JSON output discipline.\n" +
    "- Address the observed confusions with targeted decision rules (e.g. a tie-break sentence for the most-confused pair), " +
    "not by lengthening everything.\n" +
    `- "note": ONE LINE for the iteration log stating what you changed and which confusion it targets.\n\n` +
    `The construct, for reference:\n${codebookBlock(construct)}`;
  return { system, user };
}

// ----------------------------------------------------------- silver labels

export function silverLabelPrompt(construct, unit) {
  const system =
    `${DIRECTOR_PREAMBLE}\n\n` +
    "For this task you are silver-labeling a calibration sample, one unit per call. These labels become the reference workers are tuned " +
    "against until human gold supersedes them, so code with the care of a senior coder: apply the codebook as written — " +
    "not as you would have written it — and let your confidence honestly reflect genuine ambiguity.";
  const user =
    `Apply this codebook to the unit below.\n\n${codebookBlock(construct)}\n\n` +
    `${renderUnit(unit, { maxChars: 2000 })}\n\n` +
    RATIONALE_FIRST_LINE;
  return { system, user };
}

// ----------------------------------------------------------- second opinion

export function escalationPrompt({ construct, unit, output }) {
  const system =
    `${DIRECTOR_PREAMBLE}\n\n` +
    "For this task you are giving a second opinion on a single judgment that was escalated (low confidence, panel disagreement, " +
    "schema repair, or atypical length). Judge the unit independently FIRST, then compare with the worker. " +
    "Override only when the codebook clearly supports a different label — the worker being uncertain is not by itself evidence it is wrong.";
  const user =
    `${codebookBlock(construct)}\n\n` +
    `${renderUnit(unit, { maxChars: 2000 })}\n\n` +
    `THE WORKER'S JUDGMENT:\n` +
    `- label: ${JSON.stringify(output.label)}\n` +
    `- confidence: ${output.confidence ?? "(none)"}\n` +
    `- rationale: ${output.rationale ?? "(none)"}\n\n` +
    "Give your own judgment of the unit under this codebook (rationale first, then label, then confidence). " +
    'In "reason", give the researcher ONE LINE: if you agree with the worker, why the label stands; ' +
    "if you disagree, precisely what the worker got wrong.";
  return { system, user };
}

// ----------------------------------------------------------- panel design

export const AGGREGATIONS = ["majority", "mean", "median", "unanimityOrFlag", "confidenceWeighted", "reliabilityWeighted"];

export const PANEL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["jurors", "aggregation", "rationale"],
  properties: {
    jurors: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["provider", "model", "workerClass"],
        properties: {
          provider: { type: "string" },
          model: { type: "string" },
          snapshot: { type: "string" },
          workerClass: { type: "string", enum: WORKER_CLASSES },
        },
      },
    },
    aggregation: { type: "string", enum: AGGREGATIONS },
    rationale: { type: "string" },
    weights: { type: "object" },
  },
};

export function panelPrompt({ construct, candidates, budgetUSDper1k, privacyMode }) {
  const system =
    `${DIRECTOR_PREAMBLE}\n\n` +
    "For this task you are designing a judging panel: 3-5 worker models whose aggregated judgments measure one construct. " +
    "Disagreement between independent jurors is signal, so independence is the design constraint that cannot be traded away.";
  const candidateLines = candidates
    .map((c) => `- provider=${c.provider} model=${c.id} family=${c.family} ` +
      `in=$${c.pricing.inUSDper1M}/1M out=$${c.pricing.outUSDper1M}/1M (~$${c.estPer1kUSD} per 1k units)`)
    .join("\n");
  const user =
    `Recommend a panel for this construct:\n\n${codebookBlock(construct)}\n\n` +
    `AVAILABLE MODELS (the project's privacy mode is "${privacyMode}"; this list is already filtered to what that mode permits — ` +
    "choose ONLY from it):\n" +
    `${candidateLines}\n\n` +
    (budgetUSDper1k != null ? `Budget guidance: aim at or under ~$${budgetUSDper1k} per 1,000 units across all jurors combined.\n\n` : "") +
    "Hard requirements:\n" +
    "- 3 to 5 jurors, every one from a DIFFERENT model family (the family field above) — same-family models share failure modes and fake consensus.\n" +
    "- Match worker class to model capability: frontier models get lean prompts, small models get heavy scaffolding (workerClass per juror).\n" +
    "- Pick the aggregation rule that fits the construct's type and the stakes: majority for crisp categoricals; mean/median for numeric; " +
    "unanimityOrFlag when false positives are costly and humans will review flags; confidence- or reliability-weighted only when calibration data will exist to justify weights.\n" +
    '- "rationale": 2-4 sentences for the researcher: why these families, this size, this rule — and what you traded off (cost, speed, independence).\n' +
    "The researcher can edit everything you propose.";
  return { system, user };
}

// ------------------------------------------------------ analysis suggestions

// Spec property superset for the analysis kinds the Director may suggest;
// matches what the workbench's crosstab/descriptive specs consume.
const analysisSpecSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    rowKey: { type: "string" },
    colKey: { type: "string" },
    of: { type: "string" },
    by: { type: "string" },
    valueKey: { type: "string" },
    dateKey: { type: "string" },
    bucket: { type: "string", enum: ["day", "week", "month"] },
    instrumentId: { type: "string" },
    corpusId: { type: "string" },
    metaKey: { type: "string" },
  },
};

export const ANALYST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["suggestions"],
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "spec", "annotation", "evidenceRefs"],
        properties: {
          kind: { type: "string", enum: ["descriptive", "crosstab"] },
          spec: analysisSpecSchema,
          annotation: { type: "string" },
          evidenceRefs: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

export function analystPrompt({ construct, run, labelDist, metaColumns, outputsSample, unitsById }) {
  const system =
    `${DIRECTOR_PREAMBLE}\n\n` +
    "For this task you are suggesting next analyses after a completed run. Every suggestion is dismissible and must earn its click: " +
    "propose only what the label distribution and metadata in front of you make genuinely interesting, and anchor each suggestion in real coded units.";
  const distLines = Object.entries(labelDist).map(([l, n]) => `- ${l}: ${n}`).join("\n");
  const sampleLines = outputsSample
    .slice(0, 30)
    .map((o) => {
      const u = unitsById?.get?.(o.unitId);
      return `- unit ${o.unitId} → ${JSON.stringify(o.label)}${u ? ` :: "${truncate(u.text, 160)}"` : ""}`;
    })
    .join("\n");
  const user =
    `A run just completed${construct ? ` measuring "${construct.name}"` : ""} over corpus ${run.corpusId} ` +
    `(instrument ${run.instrumentId}, model ${run.model}).\n\n` +
    `Label distribution:\n${distLines}\n\n` +
    `Metadata columns available for cross-tabulation: ${metaColumns.length ? metaColumns.join(", ") : "(none)"}.\n\n` +
    `A sample of coded units:\n${sampleLines}\n\n` +
    "Suggest 1-4 analyses. For each:\n" +
    '- "kind": "crosstab" (label × a metadata column: spec {rowKey, colKey, instrumentId, corpusId}) or ' +
    '"descriptive" (prevalence/summary: spec {of, instrumentId, corpusId}).\n' +
    '- "annotation": one researcher-facing line saying what the analysis would test and why this data hints it is worth running. ' +
    "No findings language — you have a sample, not a result.\n" +
    '- "evidenceRefs": unit ids FROM THE SAMPLE ABOVE whose coded text motivated the suggestion (may be empty for purely distributional suggestions).\n' +
    "Do not suggest analyses the metadata cannot support, and never imply a conclusion.";
  return { system, user };
}

// ------------------------------------------------------------ question bar

export const QUESTION_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["constructs", "instruments", "analysis"],
  properties: {
    constructs: { type: "array", items: constructEntrySchema },
    instruments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["construct", "workerClass", "provider", "model"],
        properties: {
          construct: { type: "string" },
          workerClass: { type: "string", enum: WORKER_CLASSES },
          provider: { type: "string" },
          model: { type: "string" },
          snapshot: { type: "string" },
        },
      },
    },
    analysis: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "spec", "annotation"],
      properties: {
        kind: { type: "string", enum: ["descriptive", "crosstab"] },
        spec: analysisSpecSchema,
        annotation: { type: "string" },
      },
    },
  },
};

export function questionPrompt({ question, corpusName, unitCount, sampleUnits, metaColumns, candidates }) {
  const system =
    `${DIRECTOR_PREAMBLE}\n\n` +
    "For this task you are compiling a plain-language research question into a visible, editable measurement plan: " +
    "which construct(s) to measure, which worker model codes each, and which analysis answers the question. " +
    "You are a compiler, not an oracle: you produce the plan that WOULD answer the question, never the answer itself.";
  const candidateLines = candidates
    .map((c) => `- provider=${c.provider} model=${c.id} family=${c.family} in=$${c.pricing.inUSDper1M}/1M out=$${c.pricing.outUSDper1M}/1M`)
    .join("\n");
  const user =
    `The researcher asked:\n"${question}"\n\n` +
    `Corpus: ${corpusName} — ${unitCount} units. Metadata columns: ${metaColumns.length ? metaColumns.join(", ") : "(none)"}.\n` +
    `A sample of units:\n\n${renderUnits(sampleUnits)}\n\n` +
    `WORKER MODELS AVAILABLE (choose only from this privacy-filtered list):\n${candidateLines}\n\n` +
    "Produce the smallest plan that answers the question:\n" +
    `- "constructs": the construct(s) that must be measured, as full codebook entries.\n${CODEBOOK_CRAFT}\n` +
    '- "instruments": one judge per construct: {"construct": <exact construct name from your list>, "workerClass", "provider", "model", "snapshot"?}. ' +
    "Default to the cheapest model class the construct's subtlety allows.\n" +
    '- "analysis": the single analysis that answers the question once the run completes — "crosstab" with spec {rowKey, colKey} ' +
    '(use "label" for the measured construct and a metadata column name for the other axis) or "descriptive" with spec {of: "label"}. ' +
    'The "annotation" states, in one line, how this analysis answers the researcher\'s question.\n' +
    "If the question cannot be answered from this corpus's text and metadata, return zero constructs and say why in the analysis annotation.";
  return { system, user };
}

// -------------------------------------------------------- dictionary seeding

export const DICTIONARY_SEED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["categories"],
  properties: {
    categories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "terms"],
        properties: {
          name: { type: "string" },
          terms: { type: "array", items: { type: "string" } },
        },
      },
    },
    note: { type: "string" },
  },
};

export function dictionarySeedPrompt({ construct, sampleUnits }) {
  const system =
    `${DIRECTOR_PREAMBLE}\n\n` +
    "For this task you are seeding a closed-vocabulary dictionary: a transparent, free, local instrument. " +
    "It only measures what its terms catch, so mine the corpus's actual vocabulary rather than your own.";
  const user =
    `Propose dictionary term lists for this construct:\n\n${codebookBlock(construct)}\n\n` +
    "Term syntax (Concord dictionary engine):\n" +
    '- plain word: pay   - prefix wildcard (only at the END of a term): underpa*   - quoted phrase: "work life balance"\n' +
    "- a wildcard anywhere except the final character is INVALID and will be dropped.\n" +
    'Category naming: categories may not be named "empty" and may not start with "NOT_" (reserved for negation output).\n\n' +
    "Rules:\n" +
    "- One category per facet of the construct (often just one). 15-60 terms per category.\n" +
    "- Prefer words and phrases that actually occur in the sample units below; generalize with wildcards where morphology varies (pay, paid, payment → pay, paid, payment*).\n" +
    "- Include common misspellings only when you see them in the sample.\n" +
    "- Avoid terms that are mostly noise for this construct (e.g. 'work' for a pay construct).\n\n" +
    `SAMPLE UNITS:\n\n${renderUnits(sampleUnits)}\n\n` +
    '"note": one line on coverage limits the researcher should know about.';
  return { system, user };
}

// ---------------------------------------------------------- default template

const CLASS_TEMPLATE_HEAD = {
  frontier:
    "You are coding one unit of text against a formal codebook. Apply the codebook as written; where it is silent, choose the reading a careful human coder would defend.",
  mid:
    "You are coding one unit of text against a formal codebook. Procedure: read the unit; check every include criterion; check every exclude criterion; study the worked examples; decide.",
  small:
    "Code one unit of text using the codebook below. Follow the criteria exactly. Imitate the worked examples. Do not guess beyond the text.",
};

// Deterministic fallback/default judging template per worker class — used for
// panel jurors at recommendation time (before per-juror compilation) and as
// the compiler's structural baseline. Contains all four slots.
export function defaultTemplate(workerClass) {
  if (!WORKER_CLASSES.includes(workerClass)) {
    throw new ConcordError("VALIDATION", `unknown workerClass "${workerClass}"`, { workerClass, known: WORKER_CLASSES });
  }
  const parts = [
    CLASS_TEMPLATE_HEAD[workerClass],
    SLOT_SECTIONS["{{definition}}"],
    SLOT_SECTIONS["{{criteria}}"],
    SLOT_SECTIONS["{{examples}}"],
    SLOT_SECTIONS["{{unit}}"],
    RATIONALE_FIRST_LINE,
  ];
  if (workerClass === "small") parts.push(SMALL_STRICT_BLOCK);
  return parts.join("\n\n");
}
