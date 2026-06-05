// LLM judge: codebook → prompt assembly, schema derivation, and the single-
// unit judging call. A judge is (model + params + prompt template + output
// schema + decoding policy); this module owns the assembly and enforcement —
// the Director authors the template text itself.
//
// Label canonicalization (documented contract):
//   binary       → the construct's two category values when exactly two
//                  categories are declared, else ["yes", "no"]. Labels are
//                  emitted exactly as the enum values (strings).
//   kclass       → enum over construct.categories[].value (nominal).
//   likert       → enum over construct.categories[].value (ordinal), anchored
//                  1..k via each category's anchor (or label). Values keep
//                  their construct type: numeric category values yield numeric
//                  labels (so mean/median panel aggregation works).
//   score0to100  → a number in [0, 100] (continuous constructs).
//   multilabel   → array of construct.categories[].value entries.
//   extraction   → the model answers {rationale, spans: [...], confidence?};
//                  judgeUnit returns label = spans (string[]), satisfying the
//                  Label = string|number|string[] contract.
//
// Rationale-BEFORE-verdict: the response schema lists `rationale` first and
// the instructions demand reasoning before the label. `confidence` is
// optional in the schema; when the model omits it the output carries
// confidence: null — never an invented number.
//
// Message layout: the rendered template (slots {{definition}} {{criteria}}
// {{examples}} filled) becomes the system message — so Director-scripted
// `[[handler:name]]` markers in templates reach MockAdapter — and the unit
// fills its slot in the user message as a fenced <unit> block (MockAdapter
// extracts and seeds from the last user message). Template text after
// {{unit}} follows the unit in the user message.
import { ConcordError } from "../core/errors.js";
import { completeWithRepair } from "../providers/base.js";

export const DEFAULT_TEMPLATE = [
  "You are coding one text unit against a construct.",
  "",
  "Construct definition:",
  "{{definition}}",
  "",
  "Decision criteria:",
  "{{criteria}}",
  "",
  "Worked examples:",
  "{{examples}}",
  "",
  "Unit to code:",
  "{{unit}}",
].join("\n");

// Tighter rubric anchoring prepended for small worker models. The Director
// authors richer scaffolding in its compiled templates; this is the floor the
// assembly layer enforces for workerClass "small".
const SMALL_CLASS_SCAFFOLD = [
  "Follow the rubric below EXACTLY as written. Do not generalize beyond it.",
  "Anchor every decision to an explicit inclusion or exclusion criterion and quote the phrase from the unit that satisfies it.",
  "If two labels seem plausible, pick the one whose criteria match the most explicit wording in the unit.",
  "Never invent labels outside the allowed options. If genuinely uncertain, report low confidence rather than guessing high.",
].join("\n");

const RATIONALE_FIRST_INSTRUCTION =
  'Reason first: write your evidence-based reasoning in "rationale" BEFORE deciding the verdict. ' +
  "Then answer with ONLY one JSON object matching the required schema — no prose outside the JSON.";

// ---------------------------------------------------------------------------
// outputSchemaFor: construct → OutputSchema {type, options?, anchors?}
// ---------------------------------------------------------------------------

function categoryValues(construct, field) {
  const cats = construct.categories;
  if (!Array.isArray(cats) || cats.length === 0) {
    throw new ConcordError("VALIDATION", `${construct.type} construct needs categories to derive an output schema`, {
      constructId: construct.id, field,
    });
  }
  return cats.map((c) => c.value);
}

export function outputSchemaFor(construct) {
  if (!construct || typeof construct !== "object") {
    throw new ConcordError("VALIDATION", "outputSchemaFor requires a construct", {});
  }
  switch (construct.type) {
    case "binary": {
      const cats = Array.isArray(construct.categories) && construct.categories.length === 2
        ? construct.categories.map((c) => String(c.value))
        : ["yes", "no"];
      return { type: "binary", options: cats };
    }
    case "nominal":
      return { type: "kclass", options: categoryValues(construct, "categories").map(String) };
    case "ordinal": {
      const cats = construct.categories ?? [];
      if (cats.length === 0) {
        throw new ConcordError("VALIDATION", "ordinal construct needs categories", { constructId: construct.id });
      }
      const anchors = {};
      for (const c of cats) anchors[String(c.value)] = c.anchor ?? c.label ?? String(c.value);
      return { type: "likert", options: cats.map((c) => String(c.value)), anchors };
    }
    case "continuous":
      return { type: "score0to100" };
    case "multilabel":
      return { type: "multilabel", options: categoryValues(construct, "categories").map(String) };
    case "extraction":
      return { type: "extraction" };
    default:
      throw new ConcordError("VALIDATION", `unknown construct type "${construct?.type}"`, { type: construct?.type });
  }
}

// ---------------------------------------------------------------------------
// OutputSchema → JSON schema for completeWithRepair (rationale property FIRST)
// ---------------------------------------------------------------------------

// When every option string parses as a finite number the enum keeps numbers
// (likert 1..k must aggregate numerically); otherwise strings.
function enumValues(options) {
  const nums = options.map(Number);
  return nums.every((n) => Number.isFinite(n)) && options.every((s) => String(s).trim() !== "")
    ? nums
    : options;
}

export function jsonSchemaFor(outputSchema) {
  const base = {
    type: "object",
    additionalProperties: false,
    required: ["rationale", "label"],
    properties: { rationale: { type: "string" } }, // rationale first: reason, then verdict
  };
  switch (outputSchema.type) {
    case "binary":
    case "kclass":
      base.properties.label = { enum: enumValues(outputSchema.options) };
      break;
    case "likert":
      base.properties.label = { enum: enumValues(outputSchema.options) };
      break;
    case "score0to100":
      base.properties.label = { type: "number", minimum: 0, maximum: 100 };
      break;
    case "multilabel":
      base.properties.label = { type: "array", items: { enum: enumValues(outputSchema.options) } };
      break;
    case "extraction":
      base.required = ["rationale", "spans"];
      base.properties.spans = { type: "array", items: { type: "string" } };
      break;
    default:
      throw new ConcordError("VALIDATION", `unknown output schema type "${outputSchema?.type}"`, { outputSchema });
  }
  base.properties.confidence = { type: "number", minimum: 0, maximum: 1 }; // optional: absent → null, never invented
  return base;
}

// ---------------------------------------------------------------------------
// assemble: codebook → messages
// ---------------------------------------------------------------------------

function renderCriteria(construct) {
  const inc = construct.criteria?.include ?? [];
  const exc = construct.criteria?.exclude ?? [];
  const lines = [];
  if (inc.length) lines.push("Include when:", ...inc.map((c) => `- ${c}`));
  if (exc.length) lines.push("Exclude when:", ...exc.map((c) => `- ${c}`));
  if (construct.edgeCases?.length) lines.push("Edge cases:", ...construct.edgeCases.map((c) => `- ${c}`));
  return lines.length ? lines.join("\n") : "(no explicit criteria provided)";
}

function renderExamples(construct) {
  const ex = construct.examples ?? [];
  if (ex.length === 0) return "(no worked examples provided)";
  return ex
    .map((e) => `Text: ${e.text}\nLabel: ${JSON.stringify(e.label)} (${e.kind} example)`)
    .join("\n\n");
}

function renderOptions(outputSchema) {
  switch (outputSchema.type) {
    case "binary":
    case "kclass":
      return `Allowed labels: ${outputSchema.options.join(" | ")}`;
    case "likert":
      return [
        `Allowed labels (anchored scale): ${outputSchema.options.join(" | ")}`,
        ...outputSchema.options.map((o) => `  ${o}: ${outputSchema.anchors?.[o] ?? o}`),
      ].join("\n");
    case "score0to100":
      return "Label is a number from 0 to 100.";
    case "multilabel":
      return `Label is an array of zero or more of: ${outputSchema.options.join(" | ")}`;
    case "extraction":
      return 'Answer with "spans": an array of verbatim text spans extracted from the unit (empty if none).';
    default:
      return "";
  }
}

// → messages[] (system + user). All four slots are filled: {{definition}},
// {{criteria}}, {{examples}} render into the system message; {{unit}} renders
// into the user message as a <unit> block (any template text around the
// {{unit}} slot stays with it in the user message).
export function assemble(construct, judgePayload, unit) {
  if (!unit || typeof unit.text !== "string") {
    throw new ConcordError("VALIDATION", "assemble requires a unit with text", { unit });
  }
  const outputSchema = judgePayload?.schema ?? outputSchemaFor(construct);
  const template = judgePayload?.promptTemplate?.trim() ? judgePayload.promptTemplate : DEFAULT_TEMPLATE;

  const filled = template
    .replaceAll("{{definition}}", construct.definition || "(no definition provided)")
    .replaceAll("{{criteria}}", renderCriteria(construct))
    .replaceAll("{{examples}}", renderExamples(construct));

  // Split at the unit slot: text before it is rubric (system); the unit block
  // plus any trailing template text is the user turn.
  const at = filled.indexOf("{{unit}}");
  const head = at === -1 ? filled : filled.slice(0, at);
  const tail = at === -1 ? "" : filled.slice(at + "{{unit}}".length);
  const unitBlock = `<unit>\n${unit.text}\n</unit>`;

  const systemParts = [];
  if (judgePayload?.workerClass === "small") systemParts.push(SMALL_CLASS_SCAFFOLD);
  systemParts.push(head.trim());
  systemParts.push(renderOptions(outputSchema));
  if (judgePayload?.rationaleFirst !== false) systemParts.push(RATIONALE_FIRST_INSTRUCTION);

  return [
    { role: "system", content: systemParts.filter(Boolean).join("\n\n") },
    { role: "user", content: (unitBlock + tail).trim() },
  ];
}

// ---------------------------------------------------------------------------
// judgeUnit: one unit, one call (+ ≤2 schema repairs)
// ---------------------------------------------------------------------------

// → {label, confidence, rationale, raw, repairs, usage}. Throws
// ConcordError("SCHEMA_INVALID") when the response still fails the schema
// after the repair budget (the run engine quarantines the unit), and lets
// PROVIDER_* / TRUNCATED errors propagate untouched.
export async function judgeUnit(adapter, construct, judgePayload, unit) {
  const outputSchema = judgePayload?.schema ?? outputSchemaFor(construct);
  const schema = jsonSchemaFor(outputSchema);
  const messages = assemble(construct, judgePayload, unit);
  const params = judgePayload?.params ?? {};
  const req = {
    model: judgePayload?.model,
    messages,
    schema,
    temperature: params.temperature ?? 0,
    maxTokens: params.maxTokens ?? 256,
  };
  if (params.seed !== undefined) req.seed = params.seed;

  const res = await completeWithRepair(adapter, req, { maxRepairs: 2 });
  const json = res.json;
  const label = outputSchema.type === "extraction" ? json.spans : json.label;
  return {
    label,
    confidence: typeof json.confidence === "number" ? json.confidence : null,
    rationale: typeof json.rationale === "string" ? json.rationale : "",
    raw: typeof res.text === "string" && res.text.length ? res.text : JSON.stringify(json),
    repairs: res.repairs ?? 0,
    usage: res.usage ?? { inputTokens: 0, outputTokens: 0 },
  };
}
