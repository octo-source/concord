// Per-attempt usage metering + resume budget re-check (roadmap items).
//
// ITEM 1 — per-attempt provider usage metering (providers/base.js):
//   completeWithRepair used to return only the FINAL attempt's usage, so
//   schema-repair re-prompts and quarantined units billed the provider
//   invisibly. Now base.js accumulates every attempt that RETURNS a response:
//     - success → response.usage stays the final attempt's usage AND
//       response.attemptsUsage = {inputTokens, outputTokens, attempts} totals;
//     - throw after ≥1 returned attempt → err.details.attemptsUsage totals;
//     - an attempt that THREW returned no usage object → unmeterable boundary.
//   withTruncationRetry merges attemptsUsage across its doubled-budget retry.
//   Consumers: director.js meters attemptsUsage ONCE (wrapper removed — no
//   double-counting); the run engine meters every returned attempt, so
//   quarantined units' spend reaches run.cost.
//
// ITEM 2 — resume budget re-check (routes/runs.js):
//   the START gate runs spentUSD + estimate against project.budget.capUSD;
//   resume used to skip it. Resume now re-estimates the REMAINING units
//   (total minus done, the engine's own pending-set) and applies the same
//   checkBudget gate — same BUDGET_EXCEEDED error shape as the start path.
//
// Hermetic: MockModel only, bundles under a temp CONCORD_PROJECTS_DIR.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { completeWithRepair, withTruncationRetry } from "../../server/providers/base.js";
import { estimateRun } from "../../server/providers/costs.js";
import { callDirector, directorCosts } from "../../server/director/director.js";
import * as engineMod from "../../server/runs/engine.js";
import runsRoutes from "../../server/routes/runs.js";
import { DEFAULT_TEMPLATE } from "../../server/instruments/judge.js";
import { createProject, createConstruct, createInstrument } from "../../server/core/objects.js";
import { saveProject, loadProject, updateProject, readNdjson, projectDir } from "../../server/core/store.js";
import { getAdapter } from "../../server/providers/registry.js";
import { ConcordError } from "../../server/core/errors.js";

// ---------------------------------------------------------------- harness

let tmpRoot;
before(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "concord-metering-"));
  process.env.CONCORD_PROJECTS_DIR = tmpRoot;
});
after(async () => {
  delete process.env.CONCORD_PROJECTS_DIR;
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

const mock = getAdapter({ privacyMode: "open" }, "mock").adapter;
const ORACLE = (text) => (text.includes("pay salary") ? "yes" : "no");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["rationale", "label"],
  properties: { rationale: { type: "string" }, label: { enum: ["pay", "workload"] } },
};
const VALID = '{"rationale":"r","label":"pay"}';
const INVALID = "this is not json at all";

// Scripted adapter: each step is {text} (returns usage 10/5) or {boom: () => Error}.
function scriptedAdapter(script) {
  const calls = [];
  return {
    calls,
    async complete(req) {
      calls.push(req);
      const step = script[Math.min(calls.length - 1, script.length - 1)];
      if (step.boom) throw step.boom();
      return { text: step.text, usage: { inputTokens: 10, outputTokens: 5 }, finishReason: "stop", raw: {} };
    },
  };
}

const req = { model: "m", messages: [{ role: "user", content: "judge it" }], schema, temperature: 0, maxTokens: 64 };
const truncated = () => new ConcordError("TRUNCATED", "structured output truncated at the token limit", {});

// ================================================================ item 1: base.js

test("completeWithRepair: attemptsUsage totals every returned attempt; usage stays the final attempt's", async () => {
  // clean single attempt
  const clean = scriptedAdapter([{ text: VALID }]);
  const r1 = await completeWithRepair(clean, req);
  assert.deepEqual(r1.usage, { inputTokens: 10, outputTokens: 5 });
  assert.deepEqual(r1.attemptsUsage, { inputTokens: 10, outputTokens: 5, attempts: 1 });

  // one failed-validation attempt + the repair that lands: both bill
  const repaired = scriptedAdapter([{ text: INVALID }, { text: VALID }]);
  const r2 = await completeWithRepair(repaired, req);
  assert.equal(r2.repairs, 1);
  assert.deepEqual(r2.usage, { inputTokens: 10, outputTokens: 5 }, "usage stays the FINAL attempt's usage");
  assert.deepEqual(r2.attemptsUsage, { inputTokens: 20, outputTokens: 10, attempts: 2 },
    "the failed attempt's tokens are in the additive totals");
});

test("completeWithRepair: exhausted repairs (SCHEMA_INVALID) carry attemptsUsage on the error — quarantined spend is visible", async () => {
  const adapter = scriptedAdapter([{ text: INVALID }]);
  await assert.rejects(
    completeWithRepair(adapter, req), // default maxRepairs = 2 → 3 attempts
    (err) => {
      assert.equal(err.code, "SCHEMA_INVALID");
      assert.deepEqual(err.details.attemptsUsage, { inputTokens: 30, outputTokens: 15, attempts: 3 });
      return true;
    },
  );
});

test("completeWithRepair: a throwing attempt is unmeterable (no usage object), but prior returned attempts still ride the error", async () => {
  // attempt 1 returns (bills), attempt 2 throws TRUNCATED (no usage object)
  const adapter = scriptedAdapter([{ text: INVALID }, { boom: truncated }]);
  await assert.rejects(
    completeWithRepair(adapter, req),
    (err) => {
      assert.equal(err.code, "TRUNCATED");
      assert.deepEqual(err.details.attemptsUsage, { inputTokens: 10, outputTokens: 5, attempts: 1 },
        "only the RETURNED attempt is meterable; the throwing attempt carries no usage");
      return true;
    },
  );

  // a first-attempt throw has nothing meterable: no attemptsUsage stamped
  const firstThrow = scriptedAdapter([{ boom: truncated }]);
  await assert.rejects(
    completeWithRepair(firstThrow, { ...req, maxTokens: 64 }),
    (err) => err.code === "TRUNCATED" && err.details.attemptsUsage === undefined,
  );
});

test("withTruncationRetry: attemptsUsage merges across the doubled-budget retry (success and failure)", async () => {
  // pass 1: invalid (bills) then TRUNCATED; pass 2 at doubled budget: valid
  const adapter = scriptedAdapter([{ text: INVALID }, { boom: truncated }, { text: VALID }]);
  const res = await withTruncationRetry(
    (budget) => completeWithRepair(adapter, { ...req, maxTokens: budget }),
    { maxTokens: 64 },
  );
  assert.deepEqual(res.attemptsUsage, { inputTokens: 20, outputTokens: 10, attempts: 2 },
    "the first pass's returned attempt merges into the retry's totals");
  assert.equal(adapter.calls.length, 3);
  assert.equal(adapter.calls[2].maxTokens, 128);

  // both passes truncate: the propagated error totals every returned attempt
  const adapter2 = scriptedAdapter([{ text: INVALID }, { boom: truncated }, { text: INVALID }, { boom: truncated }]);
  await assert.rejects(
    withTruncationRetry((budget) => completeWithRepair(adapter2, { ...req, maxTokens: budget }), { maxTokens: 64 }),
    (err) => {
      assert.equal(err.code, "TRUNCATED");
      assert.deepEqual(err.details.attemptsUsage, { inputTokens: 20, outputTokens: 10, attempts: 2 });
      return true;
    },
  );
});

// ================================================================ item 1: director.js

// Fixed per-call usage so attempts are countable through the meter.
function fixUsage(t, inputTokens = 100, outputTokens = 10) {
  const proto = Object.getPrototypeOf(mock);
  mock.complete = async function patched(r) {
    const res = await proto.complete.call(this, r);
    return { ...res, usage: { inputTokens, outputTokens } };
  };
  t.after(() => { delete mock.complete; });
}

const directorSlot = (handler) => ({ provider: "mock", model: "mock-1", snapshot: "mock-1", systemSuffix: `[[handler:${handler}]]` });
const okSchema = {
  type: "object", additionalProperties: false, required: ["ok"],
  properties: { ok: { type: "string" } },
};

test("callDirector: repair attempts meter EXACTLY once — attemptsUsage is the single source, no double-counting", async (t) => {
  fixUsage(t);
  let attempts = 0;
  mock.setHandler("meter-d-repair", () => {
    attempts += 1;
    return attempts === 1 ? { wrong: true } : { ok: "yes" };
  });
  t.after(() => mock.handlers.delete("meter-d-repair"));

  const project = { id: "p_meterdirrep001", slug: "meter-dir-repair", privacyMode: "open", director: directorSlot("meter-d-repair") };
  const res = await callDirector(project, { messages: [{ role: "user", content: "go" }], schema: okSchema });
  assert.equal(res.repairs, 1);
  const costs = directorCosts(project);
  assert.equal(costs.calls, 1, "one logical Director call");
  assert.equal(costs.inputTokens, 200,
    "two attempts metered once each — 300/400 would mean the final attempt or the totals were double-counted");
  assert.equal(costs.outputTokens, 20);
});

test("callDirector: a Director call that exhausts repairs still bills — every returned attempt reaches the meter", async (t) => {
  fixUsage(t);
  mock.setHandler("meter-d-fail", () => ({ wrong: true }));
  t.after(() => mock.handlers.delete("meter-d-fail"));

  const project = { id: "p_meterdirfail01", slug: "meter-dir-fail", privacyMode: "open", director: directorSlot("meter-d-fail") };
  await assert.rejects(
    callDirector(project, { messages: [{ role: "user", content: "go" }], schema: okSchema }),
    (e) => e.code === "SCHEMA_INVALID",
  );
  const costs = directorCosts(project);
  assert.equal(costs.inputTokens, 300, "all three returned attempts bill (default repair budget)");
  assert.equal(costs.outputTokens, 30);
  assert.equal(costs.calls, 0, "a failed call is not a completed logical call");
});

// ================================================================ item 1: engine

const binaryConstruct = () =>
  createConstruct({
    id: "c_bin", name: "Pay mention", type: "binary",
    definition: "The unit mentions pay or salary.",
    criteria: { include: ["mentions pay"], exclude: [] },
  });

const judgePayload = (extra = {}) => ({
  provider: "mock", model: "mock-1", snapshot: "mock-1",
  params: { temperature: 0, maxTokens: 64 },
  promptTemplate: DEFAULT_TEMPLATE,
  rationaleFirst: true, workerClass: "frontier",
  ...extra,
});

const judgeInstrument = (extra = {}, payloadExtra = {}) =>
  createInstrument({ id: "inst_j", constructId: "c_bin", kind: "judge", name: "judge", payload: judgePayload(payloadExtra), ...extra });

function makeUnits(n, { isPay = (i) => i % 3 === 0, len = 60 } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const marker = isPay(i) ? "pay salary" : "office chair";
    return {
      id: `u_${String(i).padStart(4, "0")}`,
      text: `response ${String(i).padStart(4, "0")} about ${marker}`.padEnd(len, "."),
      meta: { dept: i % 2 ? "sales" : "ops" },
      pos: { row: i },
    };
  });
}

async function setup(slug, { units, instruments = [] }) {
  const project = createProject({ name: slug, slug, privacyMode: "open" });
  project.corpora.push({ id: "c1", name: "corpus" });
  project.constructs.push(binaryConstruct());
  project.instruments.push(...instruments);
  await saveProject(project);
  const file = path.join(projectDir(slug), "corpora", "c1", "units.ndjson");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, units.map((u) => JSON.stringify(u)).join("\n") + "\n", "utf8");
  return project;
}

// Patch the mock catalog so model calls cost real (fake) money; restores after.
function patchPricing(t, inUSDper1M = 1000, outUSDper1M = 1000) {
  const orig = mock.catalog;
  mock.catalog = async () => [
    { id: "mock-1", name: "Mock", family: "mock", ctx: 128_000, pricing: { inUSDper1M, outUSDper1M }, snapshot: "mock-1" },
  ];
  t.after(() => { mock.catalog = orig; });
}

const outputsFile = (slug, runId) => path.join(projectDir(slug), "runs", runId, "outputs.ndjson");

test("executeRun: quarantined units' attempts reach run.cost; successful units meter exactly once", async (t) => {
  const slug = "meter-quarantine";
  const N = 6;
  const units = makeUnits(N);
  const poison = units[2];
  const inst = judgeInstrument({}, { promptTemplate: `[[handler:meter-poison]]\n${DEFAULT_TEMPLATE}` });
  const project = await setup(slug, { units, instruments: [inst] });
  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);
  mock.setHandler("meter-poison", (r) => {
    const all = r.messages.map((m) => m.content).join("\n");
    const unitText = all.match(/<unit>\n([\s\S]*?)\n<\/unit>/)?.[1] ?? "";
    if (unitText === poison.text) return { garbage: true }; // schema-invalid on every attempt
    return { rationale: "scripted", label: ORACLE(unitText), confidence: 0.9 };
  });
  t.after(() => mock.handlers.delete("meter-poison"));
  fixUsage(t); // 100 in / 10 out per attempt
  patchPricing(t); // $1000 per 1M tokens in and out

  const run = await engineMod.createRun(project, { instrumentId: "inst_j", corpusId: "c1" });
  const done = await engineMod.executeRun(slug, run.id);
  assert.equal(done.status, "complete");
  assert.equal(done.quarantine.length, 1);
  assert.equal(done.quarantine[0].code, "SCHEMA_INVALID");

  // 5 clean units × 1 attempt + 1 quarantined unit × 3 attempts = 8 attempts.
  // An exact pin catches BOTH failure modes: 500 = quarantined spend invisible
  // (the old behavior), 1300 = attempts metered twice (wrapper + final usage).
  assert.equal(done.cost.inputTokens, 800, "every returned attempt bills, including the quarantined unit's three");
  assert.equal(done.cost.outputTokens, 80);
  assert.equal(done.cost.actualUSD, 0.88, "quarantined spend reaches run.cost.actualUSD (8 attempts × $0.11)");
});

// ================================================================ item 2: resume budget re-check

function routeHandler(routes, method, pattern) {
  const r = routes.find((x) => x.method === method && x.pattern === pattern);
  assert.ok(r, `route ${method} ${pattern} exists`);
  return r.handler;
}

test("resume re-checks the budget over the REMAINING units: refused under a lowered cap, resumes once raised", async (t) => {
  const slug = "meter-resume-gate";
  const N = 30;
  const units = makeUnits(N);
  const project = await setup(slug, { units, instruments: [judgeInstrument()] });
  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);
  patchPricing(t); // nonzero pricing so estimates and actuals are real dollars

  // pause exactly halfway (concurrency 1 → done == ticks when control flips)
  const run = await engineMod.createRun(project, { instrumentId: "inst_j", corpusId: "c1" });
  let control = null;
  let ticks = 0;
  const paused = await engineMod.executeRun(slug, run.id, {
    concurrency: 1,
    shouldStop: () => control,
    onTick: () => { ticks += 1; if (ticks === N / 2) control = "pause"; },
  });
  assert.equal(paused.status, "paused");
  const doneIds = new Set((await readNdjson(outputsFile(slug, run.id))).map((o) => o.unitId));
  assert.equal(doneIds.size, N / 2, "paused exactly halfway");

  // the SAME estimator the start gate uses, over remaining vs all units
  const pricing = { inUSDper1M: 1000, outUSDper1M: 1000 };
  const estArgs = { template: DEFAULT_TEMPLATE, maxTokens: 64, pricing };
  const remaining = units.filter((u) => !doneIds.has(u.id));
  const estRemaining = estimateRun({ units: remaining, ...estArgs }).estUSD;
  const estTotal = estimateRun({ units, ...estArgs }).estUSD;
  assert.ok(estRemaining > 0 && estRemaining < estTotal);
  const spent = paused.cost.actualUSD;

  const resume = routeHandler(runsRoutes, "POST", "/api/projects/:p/runs/:r/resume");

  // cap below spent + remaining estimate → refused with the start gate's shape
  await updateProject(slug, (p) => { p.budget = { capUSD: spent + estRemaining * 0.5, spentUSD: spent }; });
  await assert.rejects(
    resume({}, null, { p: slug, r: run.id }),
    (err) => {
      assert.equal(err.code, "BUDGET_EXCEEDED");
      assert.match(err.message, /budget cap/);
      assert.equal(typeof err.details.spentUSD, "number");
      assert.equal(typeof err.details.capUSD, "number");
      return true;
    },
  );
  assert.equal((await loadProject(slug)).runs[0].status, "paused",
    "a refused resume mutates nothing — the run stays paused");

  // cap between the REMAINING estimate and the full estimate → resumes:
  // proves the gate estimates total-minus-done, not the whole corpus again
  await updateProject(slug, (p) => { p.budget = { capUSD: spent + estRemaining * 1.5, spentUSD: spent }; });
  assert.ok(spent + estRemaining * 1.5 < spent + estTotal, "this cap WOULD refuse a full-corpus re-estimate");
  const out = await resume({}, null, { p: slug, r: run.id });
  assert.equal(out.status, "running");
  assert.equal(out.resumed, true);

  let settled = null;
  for (let i = 0; i < 100; i++) {
    settled = (await loadProject(slug)).runs[0];
    if (settled.status !== "running") break;
    await sleep(50);
  }
  assert.equal(settled.status, "complete", "raised cap → the resume completes");
  const lines = await readNdjson(outputsFile(slug, run.id));
  assert.equal(lines.length, N, "exactly-once outputs across pause + gated resume");
});

test("resume with no project cap stays ungated", async (t) => {
  const slug = "meter-resume-nocap";
  const N = 8;
  const project = await setup(slug, { units: makeUnits(N), instruments: [judgeInstrument()] });
  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);
  patchPricing(t);

  const run = await engineMod.createRun(project, { instrumentId: "inst_j", corpusId: "c1" });
  let control = null;
  let ticks = 0;
  await engineMod.executeRun(slug, run.id, {
    concurrency: 1,
    shouldStop: () => control,
    onTick: () => { ticks += 1; if (ticks === 3) control = "pause"; },
  });

  const resume = routeHandler(runsRoutes, "POST", "/api/projects/:p/runs/:r/resume");
  const out = await resume({}, null, { p: slug, r: run.id });
  assert.equal(out.status, "running");
  let settled = null;
  for (let i = 0; i < 100; i++) {
    settled = (await loadProject(slug)).runs[0];
    if (settled.status !== "running") break;
    await sleep(50);
  }
  assert.equal(settled.status, "complete");
});
