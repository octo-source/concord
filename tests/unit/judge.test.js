// Task F — judge tests (prompt assembly, schema derivation, judgeUnit with
// MockModel + stub adapters). Hermetic: no network, no disk, $0.
import { test } from "node:test";
import assert from "node:assert/strict";

import { assemble, judgeUnit, outputSchemaFor, jsonSchemaFor, DEFAULT_TEMPLATE } from "../../server/instruments/judge.js";
import { MockAdapter } from "../../server/providers/mock.js";
import { createConstruct } from "../../server/core/objects.js";
import { ConcordError } from "../../server/core/errors.js";

// ---------------------------------------------------------------- fixtures

const binaryConstruct = createConstruct({
  name: "Pay mention",
  type: "binary",
  definition: "The unit mentions compensation, salary, or pay.",
  criteria: {
    include: ["explicit mention of salary or wages", "complaints about being underpaid"],
    exclude: ["benefits without pay context"],
  },
  edgeCases: ["bonuses count as pay"],
  examples: [
    { text: "My salary was too low.", label: "yes", kind: "positive" },
    { text: "The office was cold.", label: "no", kind: "negative" },
  ],
});

const nominalConstruct = createConstruct({
  name: "Theme",
  type: "nominal",
  definition: "Dominant theme of the response.",
  categories: [
    { value: "pay", label: "Pay" },
    { value: "management", label: "Management" },
    { value: "workload", label: "Workload" },
  ],
});

const ordinalConstruct = createConstruct({
  name: "Satisfaction",
  type: "ordinal",
  definition: "Expressed satisfaction.",
  categories: [
    { value: 1, label: "Very dissatisfied", anchor: "explicit anger or regret" },
    { value: 2, label: "Dissatisfied" },
    { value: 3, label: "Neutral" },
    { value: 4, label: "Satisfied" },
    { value: 5, label: "Very satisfied", anchor: "explicit praise" },
  ],
});

const continuousConstruct = createConstruct({
  name: "Negativity",
  type: "continuous",
  definition: "Overall negativity.",
  scale: { min: 0, max: 100 },
});

const multilabelConstruct = createConstruct({
  name: "Themes",
  type: "multilabel",
  definition: "All themes present.",
  categories: [
    { value: "pay", label: "Pay" },
    { value: "growth", label: "Growth" },
  ],
});

const extractionConstruct = createConstruct({
  name: "Quit phrases",
  type: "extraction",
  definition: "Verbatim phrases expressing intent to quit.",
});

const judgePayload = {
  provider: "mock",
  model: "mock-1",
  snapshot: "mock-1",
  params: { temperature: 0, maxTokens: 256 },
  promptTemplate: DEFAULT_TEMPLATE,
  rationaleFirst: true,
  workerClass: "frontier",
};

const unit = { id: "u_1", text: "I quit because my salary was insultingly low.", meta: {}, pos: {} };

// A stub adapter that returns scripted responses in order (for repair /
// quarantine paths). completeWithRepair only needs .complete().
function scriptedAdapter(responses) {
  let i = 0;
  const calls = [];
  return {
    calls,
    complete: async (req) => {
      calls.push(req);
      const r = responses[Math.min(i++, responses.length - 1)];
      return { text: typeof r === "string" ? r : JSON.stringify(r), usage: { inputTokens: 10, outputTokens: 5 }, finishReason: "stop", raw: {} };
    },
  };
}

// ---------------------------------------------------------------- outputSchemaFor

test("outputSchemaFor: binary defaults to yes/no", () => {
  assert.deepEqual(outputSchemaFor(binaryConstruct), { type: "binary", options: ["yes", "no"] });
});

test("outputSchemaFor: binary with two declared categories uses their values", () => {
  const c = createConstruct({
    name: "B", type: "binary", definition: "d",
    categories: [{ value: "present", label: "Present" }, { value: "absent", label: "Absent" }],
  });
  assert.deepEqual(outputSchemaFor(c), { type: "binary", options: ["present", "absent"] });
});

test("outputSchemaFor: nominal → kclass with category values", () => {
  assert.deepEqual(outputSchemaFor(nominalConstruct), { type: "kclass", options: ["pay", "management", "workload"] });
});

test("outputSchemaFor: ordinal → likert with anchors (anchor, else label)", () => {
  const s = outputSchemaFor(ordinalConstruct);
  assert.equal(s.type, "likert");
  assert.deepEqual(s.options, ["1", "2", "3", "4", "5"]);
  assert.equal(s.anchors["1"], "explicit anger or regret");
  assert.equal(s.anchors["2"], "Dissatisfied"); // falls back to label
});

test("outputSchemaFor: continuous → score0to100; multilabel and extraction", () => {
  assert.deepEqual(outputSchemaFor(continuousConstruct), { type: "score0to100" });
  assert.deepEqual(outputSchemaFor(multilabelConstruct), { type: "multilabel", options: ["pay", "growth"] });
  assert.deepEqual(outputSchemaFor(extractionConstruct), { type: "extraction" });
});

test("outputSchemaFor: nominal without categories throws VALIDATION", () => {
  assert.throws(
    () => outputSchemaFor({ id: "c_x", type: "nominal" }),
    (e) => e instanceof ConcordError && e.code === "VALIDATION",
  );
});

// ---------------------------------------------------------------- jsonSchemaFor

test("jsonSchemaFor: rationale is the FIRST property (reason before verdict)", () => {
  for (const c of [binaryConstruct, nominalConstruct, ordinalConstruct, continuousConstruct, multilabelConstruct, extractionConstruct]) {
    const js = jsonSchemaFor(outputSchemaFor(c));
    assert.equal(Object.keys(js.properties)[0], "rationale", `${c.type}: rationale first`);
  }
});

test("jsonSchemaFor: likert enum keeps NUMBERS when category values are numeric", () => {
  const js = jsonSchemaFor(outputSchemaFor(ordinalConstruct));
  assert.deepEqual(js.properties.label.enum, [1, 2, 3, 4, 5]);
});

test("jsonSchemaFor: confidence is optional (not required) and bounded 0..1", () => {
  const js = jsonSchemaFor(outputSchemaFor(binaryConstruct));
  assert.ok(!js.required.includes("confidence"));
  assert.deepEqual(js.properties.confidence, { type: "number", minimum: 0, maximum: 1 });
});

test("jsonSchemaFor: extraction requires spans (array of strings), no label", () => {
  const js = jsonSchemaFor(outputSchemaFor(extractionConstruct));
  assert.deepEqual(js.required, ["rationale", "spans"]);
  assert.deepEqual(js.properties.spans, { type: "array", items: { type: "string" } });
});

// ---------------------------------------------------------------- assemble

test("assemble: fills all four slots and leaves no {{placeholder}} behind", () => {
  const messages = assemble(binaryConstruct, judgePayload, unit);
  const all = messages.map((m) => m.content).join("\n");
  assert.ok(all.includes(binaryConstruct.definition), "definition filled");
  assert.ok(all.includes("explicit mention of salary or wages"), "include criteria filled");
  assert.ok(all.includes("benefits without pay context"), "exclude criteria filled");
  assert.ok(all.includes("bonuses count as pay"), "edge cases filled");
  assert.ok(all.includes("My salary was too low."), "examples filled");
  assert.ok(all.includes(unit.text), "unit filled");
  assert.ok(!/\{\{[a-z]+\}\}/i.test(all), "no unfilled placeholder remains");
});

test("assemble: rationale-first instruction present; unit isolated in the user turn as a <unit> block", () => {
  const messages = assemble(binaryConstruct, judgePayload, unit);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[1].role, "user");
  assert.match(messages[0].content, /rationale.*BEFORE/i);
  assert.ok(messages[1].content.includes(`<unit>\n${unit.text}\n</unit>`));
  assert.ok(!messages[0].content.includes(unit.text), "unit text stays out of the system message");
});

test("assemble: rationaleFirst false drops the instruction", () => {
  const messages = assemble(binaryConstruct, { ...judgePayload, rationaleFirst: false }, unit);
  assert.ok(!/BEFORE deciding/i.test(messages[0].content));
});

test('assemble: workerClass "small" prepends tighter rubric anchoring; frontier does not', () => {
  const small = assemble(binaryConstruct, { ...judgePayload, workerClass: "small" }, unit);
  const frontier = assemble(binaryConstruct, judgePayload, unit);
  assert.match(small[0].content, /EXACTLY as written/);
  assert.ok(small[0].content.indexOf("EXACTLY as written") < small[0].content.indexOf(binaryConstruct.definition), "scaffold is PREPENDED");
  assert.doesNotMatch(frontier[0].content, /EXACTLY as written/);
});

test("assemble: likert anchors and allowed options are described to the model", () => {
  const messages = assemble(ordinalConstruct, { ...judgePayload, schema: undefined }, unit);
  const sys = messages[0].content;
  assert.match(sys, /1.*explicit anger or regret/);
  assert.match(sys, /Allowed labels/);
});

test("assemble: empty promptTemplate falls back to the default template", () => {
  const messages = assemble(binaryConstruct, { ...judgePayload, promptTemplate: "" }, unit);
  assert.ok(messages.map((m) => m.content).join("\n").includes(binaryConstruct.definition));
});

test("assemble: template text after {{unit}} stays in the user turn", () => {
  const tpl = "Definition: {{definition}}\nCriteria: {{criteria}}\nExamples: {{examples}}\nUnit: {{unit}}\nRemember: code conservatively.";
  const messages = assemble(binaryConstruct, { ...judgePayload, promptTemplate: tpl }, unit);
  assert.ok(messages[1].content.includes("Remember: code conservatively."));
  assert.ok(!messages[0].content.includes("Remember: code conservatively."));
});

test("assemble: owns the <unit> wrapper — legacy <unit>{{unit}}</unit> templates do not double-wrap", () => {
  const tpl = "Definition: {{definition}}\nCriteria: {{criteria}}\nExamples: {{examples}}\nUnit to code:\n<unit>{{unit}}</unit>\nCode conservatively.";
  const messages = assemble(binaryConstruct, { ...judgePayload, promptTemplate: tpl }, unit);
  const all = messages.map((m) => m.content).join("\n");
  assert.equal(all.split("<unit>").length - 1, 1, "exactly one <unit> open tag in the assembled messages");
  assert.equal(all.split("</unit>").length - 1, 1, "exactly one </unit> close tag in the assembled messages");
  assert.ok(messages[1].content.includes(`<unit>\n${unit.text}\n</unit>`), "the surviving wrapper is assemble's own fenced block");
  assert.ok(messages[1].content.includes("Code conservatively."), "template text after the slot still rides in the user turn");
});

test("assemble: missing unit text throws VALIDATION", () => {
  assert.throws(() => assemble(binaryConstruct, judgePayload, {}), (e) => e.code === "VALIDATION");
});

// ---------------------------------------------------------------- judgeUnit

test("judgeUnit: happy path with MockModel + oracle (accuracy 1.0)", async () => {
  const adapter = new MockAdapter({ accuracy: 1.0 });
  adapter.setOracle((text) => (text.includes("salary") ? "yes" : "no"));
  const out = await judgeUnit(adapter, binaryConstruct, judgePayload, unit);
  assert.equal(out.label, "yes");
  assert.ok(typeof out.confidence === "number" && out.confidence >= 0 && out.confidence <= 1);
  assert.ok(typeof out.rationale === "string" && out.rationale.length > 0);
  assert.equal(out.repairs, 0);
  assert.ok(out.usage.inputTokens > 0 && out.usage.outputTokens > 0);
  assert.ok(typeof out.raw === "string" && out.raw.length > 0);
});

test("judgeUnit: deterministic — same adapter, same unit, same output", async () => {
  const adapter = new MockAdapter({ accuracy: 0.9 });
  const a = await judgeUnit(adapter, nominalConstruct, judgePayload, unit);
  const b = await judgeUnit(adapter, nominalConstruct, judgePayload, unit);
  assert.deepEqual(a, b);
});

test("judgeUnit: label stays inside the construct enum even on mock disagreement", async () => {
  const adapter = new MockAdapter({ accuracy: 0.0 }); // always disagree
  adapter.setOracle(() => "pay");
  const out = await judgeUnit(adapter, nominalConstruct, judgePayload, unit);
  assert.notEqual(out.label, "pay");
  assert.ok(["management", "workload"].includes(out.label));
});

test("judgeUnit: likert labels come back numeric", async () => {
  const adapter = new MockAdapter({ accuracy: 1.0 });
  adapter.setOracle(() => 4);
  const out = await judgeUnit(adapter, ordinalConstruct, judgePayload, unit);
  assert.equal(out.label, 4);
  assert.equal(typeof out.label, "number");
});

test("judgeUnit: extraction returns label = spans (string[])", async () => {
  const adapter = new MockAdapter({ accuracy: 1.0 });
  const out = await judgeUnit(adapter, extractionConstruct, judgePayload, unit);
  assert.ok(Array.isArray(out.label));
  for (const span of out.label) assert.equal(typeof span, "string");
});

test("judgeUnit: schema-repair path — one bad response then valid → repairs: 1", async () => {
  const adapter = scriptedAdapter([
    "utter garbage, not json at all",
    { rationale: "mentions salary explicitly", label: "yes", confidence: 0.83 },
  ]);
  const out = await judgeUnit(adapter, binaryConstruct, judgePayload, unit);
  assert.equal(out.label, "yes");
  assert.equal(out.repairs, 1);
  assert.equal(adapter.calls.length, 2);
  // the repair re-prompt carries the schema and the problem description
  const repairMsg = adapter.calls[1].messages.at(-1);
  assert.equal(repairMsg.role, "user");
  assert.match(repairMsg.content, /not valid JSON|schema/);
});

test("judgeUnit: quarantine path — garbage 3 times → SCHEMA_INVALID after 2 repairs", async () => {
  const adapter = scriptedAdapter(["nope", "still nope", "never json"]);
  await assert.rejects(
    () => judgeUnit(adapter, binaryConstruct, judgePayload, unit),
    (e) => e instanceof ConcordError && e.code === "SCHEMA_INVALID",
  );
  assert.equal(adapter.calls.length, 3); // initial + 2 repairs, then give up
});

test("judgeUnit: off-enum label is repaired, not accepted", async () => {
  const adapter = scriptedAdapter([
    { rationale: "r", label: "maybe", confidence: 0.5 }, // not in [yes, no]
    { rationale: "r", label: "no", confidence: 0.7 },
  ]);
  const out = await judgeUnit(adapter, binaryConstruct, judgePayload, unit);
  assert.equal(out.label, "no");
  assert.equal(out.repairs, 1);
});

test("judgeUnit: absent confidence → null, never invented", async () => {
  const adapter = scriptedAdapter([{ rationale: "clear pay mention", label: "yes" }]);
  const out = await judgeUnit(adapter, binaryConstruct, judgePayload, unit);
  assert.equal(out.label, "yes");
  assert.strictEqual(out.confidence, null);
});

test("judgeUnit: PROVIDER_REFUSAL propagates untouched (no repair loop)", async () => {
  const adapter = {
    calls: 0,
    async complete() {
      this.calls++;
      throw new ConcordError("PROVIDER_REFUSAL", "model refused");
    },
  };
  await assert.rejects(() => judgeUnit(adapter, binaryConstruct, judgePayload, unit), (e) => e.code === "PROVIDER_REFUSAL");
  assert.equal(adapter.calls, 1);
});

test("judgeUnit: params.seed threads into the request (mock varies by seed)", async () => {
  const adapter = new MockAdapter({ accuracy: 0.5 });
  adapter.setOracle(() => "pay");
  const seen = new Set();
  for (const seed of ["s1", "s2", "s3", "s4", "s5", "s6"]) {
    const out = await judgeUnit(adapter, nominalConstruct, { ...judgePayload, params: { ...judgePayload.params, seed } }, unit);
    seen.add(JSON.stringify(out));
  }
  assert.ok(seen.size > 1, "distinct seeds must decorrelate outputs");
});
