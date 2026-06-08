// Task F — run engine, stability, and monitor tests. Hermetic: MockModel
// only (deterministic, $0), every project bundle in a per-test temp dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createRun, executeRun, runEphemeral, parseUnitFilter } from "../../server/runs/engine.js";
import * as monitor from "../../server/runs/monitor.js";
import { stabilityCheck } from "../../server/instruments/stability.js";
import { DEFAULT_TEMPLATE } from "../../server/instruments/judge.js";
import { createProject, createConstruct, createInstrument, freeze, instrumentVersionHash } from "../../server/core/objects.js";
import { saveProject, loadProject, readNdjson, updateProject, projectsDir } from "../../server/core/store.js";
import * as ledger from "../../server/core/ledger.js";
import { getAdapter } from "../../server/providers/registry.js";
import { ConcordError } from "../../server/core/errors.js";

// ---------------------------------------------------------------- fixtures

const SLUG = "runs-test";

const binaryConstruct = () =>
  createConstruct({
    id: "c_bin",
    name: "Pay mention",
    type: "binary",
    definition: "The unit mentions pay or salary.",
    criteria: { include: ["mentions pay"], exclude: [] },
  });

const judgePayload = (extra = {}) => ({
  provider: "mock",
  model: "mock-1",
  snapshot: "mock-1",
  params: { temperature: 0, maxTokens: 64 },
  promptTemplate: DEFAULT_TEMPLATE,
  rationaleFirst: true,
  workerClass: "frontier",
  ...extra,
});

const judgeInstrument = (extra = {}, payloadExtra = {}) =>
  createInstrument({ id: "inst_j", constructId: "c_bin", kind: "judge", name: "judge", payload: judgePayload(payloadExtra), ...extra });

// Fixed-width unit texts (equal lengths → the p99-length escalation
// predicate stays quiet unless a test plants a long unit on purpose).
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

const ORACLE = (text) => (text.includes("pay salary") ? "yes" : "no");

async function setup(t, { units, instruments = [], constructs = [binaryConstruct()], director = null } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "concord-runs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = createProject({ name: "Runs Test", slug: SLUG, privacyMode: "open" });
  project.director = director;
  project.corpora.push({ id: "c1", name: "corpus" });
  project.constructs.push(...constructs);
  project.instruments.push(...instruments);
  await saveProject(project, dir);
  const file = path.join(dir, SLUG, "corpora", "c1", "units.ndjson");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, units.length ? units.map((u) => JSON.stringify(u)).join("\n") + "\n" : "", "utf8");
  return { dir, project, pdir: path.join(dir, SLUG) };
}

// The registry memoizes the mock adapter: grab the shared instance and put it
// in a known state. Tests that patch methods restore them via t.after.
function mockAdapter(project, { accuracy = 1.0, oracle = ORACLE } = {}) {
  const { adapter } = getAdapter(project, "mock");
  adapter.setAccuracy(accuracy);
  adapter.setOracle(oracle);
  return adapter;
}

// Patch the mock catalog so model calls cost real (fake) money; restores after.
function patchPricing(t, adapter, inUSDper1M = 1000, outUSDper1M = 1000) {
  const orig = adapter.catalog;
  adapter.catalog = async () => [
    { id: "mock-1", name: "Mock", family: "mock", ctx: 128_000, pricing: { inUSDper1M, outUSDper1M }, snapshot: "mock-1" },
  ];
  t.after(() => { adapter.catalog = orig; });
}

const outputsFile = (pdir, runId) => path.join(pdir, "runs", runId, "outputs.ndjson");

function assertExactlyOnce(lines) {
  const seen = new Set();
  for (const l of lines) {
    const k = `${l.unitId}|${l.juror}`;
    assert.ok(!seen.has(k), `duplicate output line for ${k}`);
    seen.add(k);
  }
}

// ---------------------------------------------------------------- unitFilter

test("parseUnitFilter: meta.<key>=<value> matches; bad syntax throws", () => {
  const f = parseUnitFilter("meta.dept=sales");
  assert.equal(f({ meta: { dept: "sales" } }), true);
  assert.equal(f({ meta: { dept: "ops" } }), false);
  assert.equal(parseUnitFilter(""), null);
  assert.throws(() => parseUnitFilter("dept=sales"), (e) => e.code === "VALIDATION");
});

// ---------------------------------------------------------------- createRun

test("createRun: validates instrument and corpus, persists a pending run, ledgers run.preflight", async (t) => {
  const { dir, project, pdir } = await setup(t, { units: makeUnits(10), instruments: [judgeInstrument()] });
  mockAdapter(project);

  await assert.rejects(() => createRun(project, { instrumentId: "nope", corpusId: "c1" }, { dir }), (e) => e.code === "NOT_FOUND");
  await assert.rejects(() => createRun(project, { instrumentId: "inst_j", corpusId: "nope" }, { dir }), (e) => e.code === "NOT_FOUND");

  const run = await createRun(project, { instrumentId: "inst_j", corpusId: "c1", capUSD: 5 }, { dir });
  assert.equal(run.status, "pending");
  assert.deepEqual(run.checkpoint, { done: 0, total: 10 });
  assert.equal(run.capUSD, 5);
  assert.equal(run.provider, "mock");
  assert.equal(run.snapshot, "mock-1");
  assert.equal(run.pinned, true);
  assert.ok(run.cost.estUSD >= 0);

  const onDisk = await loadProject(SLUG, dir);
  assert.equal(onDisk.runs.length, 1);
  assert.equal(onDisk.runs[0].id, run.id);

  const events = await ledger.query(pdir, { type: "run.preflight" });
  assert.equal(events.length, 1);
  assert.equal(events[0].refs.runId, run.id);
  assert.equal(events[0].payload.units, 10);
  assert.equal(events[0].payload.calls, 10);
});

// ---------------------------------------------------------------- full run

test("executeRun: 500-unit run completes with checkpoints, ledger events, exact label distribution", async (t) => {
  const N = 500;
  const { dir, project, pdir } = await setup(t, { units: makeUnits(N), instruments: [judgeInstrument()] });
  mockAdapter(project, { accuracy: 1.0 });

  const run = await createRun(project, { instrumentId: "inst_j", corpusId: "c1" }, { dir });
  const ticks = [];
  let lastTick = null;
  const done = await executeRun(SLUG, run.id, { dir, onTick: (s) => { ticks.push(s.done); lastTick = s; } });

  assert.equal(done.status, "complete");
  assert.deepEqual(done.checkpoint, { done: N, total: N });
  assert.ok(done.startedAt && done.finishedAt);
  assert.equal(done.cost.actualUSD, 0); // mock is $0 at catalog pricing
  assert.ok(done.cost.inputTokens > 0 && done.cost.outputTokens > 0);
  assert.equal(done.escalation.count, 0);
  assert.equal(done.quarantine.length, 0);

  const lines = await readNdjson(outputsFile(pdir, run.id));
  assert.equal(lines.length, N);
  assertExactlyOnce(lines);
  // oracle at accuracy 1.0 → label distribution is exactly the planted rate
  const yes = lines.filter((l) => l.label === "yes").length;
  assert.equal(yes, Math.ceil(N / 3));
  for (const l of lines) {
    assert.equal(l.juror, done.versionHash);
    assert.ok(typeof l.rationale === "string" && l.rationale.length > 0);
    assert.ok(l.confidence === undefined || (l.confidence >= 0 && l.confidence <= 1));
  }

  assert.equal(ticks.length, N);
  assert.equal(ticks.at(-1), N);

  const started = await ledger.query(pdir, { type: "run.started" });
  const completed = await ledger.query(pdir, { type: "run.completed" });
  assert.equal(started.length, 1);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].payload.done, N);
  assert.equal((await ledger.query(pdir, { type: "run.escalation_summary" })).length, 0);

  // monitor telemetry was truthful through the run (the final tick saw it all)…
  assert.equal(lastTick.done, N);
  assert.equal(lastTick.labelDist.yes, Math.ceil(N / 3));
  assert.equal(lastTick.warnings.length, 0);
  // …and a COMPLETE run clears its monitor state (hygiene: the module-level
  // Map must not grow without bound; paused/aborted runs keep state for resume)
  assert.equal(monitor.runState(run.id), null, "complete run clears monitor state");

  // checkpoints really persisted along the way: the run on disk is complete
  const onDisk = await loadProject(SLUG, dir);
  assert.equal(onDisk.runs[0].status, "complete");
});

test("executeRun: dictionary instruments run through the same outputs path at $0 (no model calls)", async (t) => {
  const dictPayload = {
    categories: [{ name: "pay", terms: [{ term: "pay" }, { term: "salary" }] }],
    negation: { enabled: false, window: 3 },
    scoring: "count",
  };
  const inst = createInstrument({ id: "inst_d", constructId: "c_bin", kind: "dictionary", name: "dict", payload: dictPayload });
  const { dir, project, pdir } = await setup(t, { units: makeUnits(40), instruments: [inst] });
  // poison the adapter: ANY model call would throw
  const adapter = mockAdapter(project);
  const orig = adapter.complete.bind(adapter);
  adapter.complete = async () => { throw new Error("dictionary runs must not call a model"); };
  t.after(() => { adapter.complete = orig; });

  const run = await createRun(project, { instrumentId: "inst_d", corpusId: "c1" }, { dir });
  assert.equal(run.provider, "local");
  assert.equal(run.model, "dictionary");
  assert.equal(run.cost.estUSD, 0);

  const done = await executeRun(SLUG, run.id, { dir });
  assert.equal(done.status, "complete");
  assert.equal(done.cost.actualUSD, 0);
  assert.equal(done.cost.inputTokens, 0);

  const lines = await readNdjson(outputsFile(pdir, run.id));
  assert.equal(lines.length, 40);
  assertExactlyOnce(lines);
  for (const l of lines) {
    const expected = ORACLE(makeUnits(40).find((u) => u.id === l.unitId).text);
    assert.equal(l.label, expected, `dictionary label matches lexical truth for ${l.unitId}`);
    assert.ok(l.scores && typeof l.scores.pay === "number");
  }
  assert.equal((await ledger.query(pdir, { type: "run.completed" })).length, 1);
});

// ---------------------------------------------------------------- resume / abort / cache

test("executeRun: budget cap aborts mid-stream cleanly; resume completes exactly-once", async (t) => {
  const N = 60;
  const { dir, project, pdir } = await setup(t, { units: makeUnits(N), instruments: [judgeInstrument()] });
  const adapter = mockAdapter(project, { accuracy: 1.0 });
  patchPricing(t, adapter); // $1000/1M tokens → each call costs real money

  const run = await createRun(project, { instrumentId: "inst_j", corpusId: "c1", capUSD: 0.01 }, { dir });
  const aborted = await executeRun(SLUG, run.id, { dir });

  assert.equal(aborted.status, "aborted");
  assert.ok(aborted.checkpoint.done > 0, "made progress before the cap");
  assert.ok(aborted.checkpoint.done < N, "the cap killed the run mid-stream");
  assert.ok(aborted.cost.actualUSD >= 0.01, "spent at least the cap");
  const partial = await readNdjson(outputsFile(pdir, run.id));
  assert.ok(partial.length > 0 && partial.length < N);
  assertExactlyOnce(partial);
  assert.equal((await ledger.query(pdir, { type: "run.aborted" })).length, 1);

  // resume with a raised cap → completes; outputs are exactly-once
  const done = await executeRun(SLUG, run.id, { dir, capUSD: 1e9 });
  assert.equal(done.status, "complete");
  assert.equal(done.checkpoint.done, N);
  const lines = await readNdjson(outputsFile(pdir, run.id));
  assert.equal(lines.length, N);
  assertExactlyOnce(lines);
  // resume must SKIP done units: nothing re-judged, so the resumed half plus
  // the aborted half partition the corpus
  const partialIds = new Set(partial.map((l) => l.unitId));
  for (const l of lines.slice(0, partial.length)) assert.ok(partialIds.has(l.unitId));

  const started = await ledger.query(pdir, { type: "run.started" });
  assert.equal(started.length, 2);
  assert.equal(started[1].payload.resumed, true);
  assert.equal(started[1].payload.pendingUnits, N - partial.length);
});

test("executeRun: PROVIDER_UNREACHABLE pauses the run (resumable), good units are never quarantined", async (t) => {
  const N = 24;
  const { dir, project, pdir } = await setup(t, { units: makeUnits(N), instruments: [judgeInstrument()] });
  const adapter = mockAdapter(project, { accuracy: 1.0 });

  const orig = adapter.complete.bind(adapter);
  let calls = 0;
  adapter.complete = async (req) => {
    calls += 1;
    if (calls > 8) throw new ConcordError("PROVIDER_UNREACHABLE", "network down", { kind: "TypeError" });
    return orig(req);
  };
  t.after(() => { adapter.complete = orig; });

  const run = await createRun(project, { instrumentId: "inst_j", corpusId: "c1" }, { dir });
  const paused = await executeRun(SLUG, run.id, { dir });
  assert.equal(paused.status, "paused");
  assert.equal(paused.error.code, "PROVIDER_UNREACHABLE");
  assert.equal(paused.quarantine.length, 0, "infrastructure faults never quarantine units");
  const partial = await readNdjson(outputsFile(pdir, run.id));
  assert.ok(partial.length >= 1 && partial.length < N);

  // network restored → resume completes exactly-once
  adapter.complete = orig;
  const done = await executeRun(SLUG, run.id, { dir });
  assert.equal(done.status, "complete");
  assert.equal(done.error, undefined);
  const lines = await readNdjson(outputsFile(pdir, run.id));
  assert.equal(lines.length, N);
  assertExactlyOnce(lines);
});

test("executeRun: shouldStop hook pauses mid-run — the engine drains, writes paused itself, appends nothing after; resume completes exactly-once", async (t) => {
  const N = 60;
  const { dir, project, pdir } = await setup(t, { units: makeUnits(N), instruments: [judgeInstrument()] });
  mockAdapter(project, { accuracy: 1.0 });
  const run = await createRun(project, { instrumentId: "inst_j", corpusId: "c1" }, { dir });

  let control = null;
  let ticks = 0;
  const paused = await executeRun(SLUG, run.id, {
    dir,
    shouldStop: () => control,
    onTick: () => { ticks += 1; if (ticks === 5) control = "pause"; },
  });
  assert.equal(paused.status, "paused");
  assert.equal(paused.error, undefined, "a user pause is not an error");
  const partial = await readNdjson(outputsFile(pdir, run.id));
  assert.ok(partial.length >= 5 && partial.length < N, `paused mid-run (${partial.length}/${N})`);
  assertExactlyOnce(partial);
  assert.equal(paused.checkpoint.done, partial.length, "in-flight pool work drained and checkpointed before returning");

  // the engine settled before resolving: no post-pause output lines, ever
  await new Promise((r) => setTimeout(r, 80));
  assert.equal((await readNdjson(outputsFile(pdir, run.id))).length, partial.length, "no post-pause output lines");
  assert.equal((await loadProject(SLUG, dir)).runs[0].status, "paused", "paused status persisted by the engine itself");

  control = null;
  const done = await executeRun(SLUG, run.id, { dir, shouldStop: () => control });
  assert.equal(done.status, "complete");
  const lines = await readNdjson(outputsFile(pdir, run.id));
  assert.equal(lines.length, N, "resume fills exactly the missing units");
  assertExactlyOnce(lines);
  const started = await ledger.query(pdir, { type: "run.started" });
  assert.equal(started.length, 2);
  assert.equal(started[1].payload.resumed, true);
  assert.equal(started[1].payload.pendingUnits, N - partial.length);
});

test("executeRun: shouldStop hook aborts — status aborted + resumable; user aborts are the CALLER's ledger event, not the engine's", async (t) => {
  const N = 40;
  const { dir, project, pdir } = await setup(t, { units: makeUnits(N), instruments: [judgeInstrument()] });
  mockAdapter(project, { accuracy: 1.0 });
  const run = await createRun(project, { instrumentId: "inst_j", corpusId: "c1" }, { dir });

  let control = null;
  let ticks = 0;
  const aborted = await executeRun(SLUG, run.id, {
    dir,
    shouldStop: () => control,
    onTick: () => { ticks += 1; if (ticks === 3) control = "abort"; },
  });
  assert.equal(aborted.status, "aborted");
  const partial = await readNdjson(outputsFile(pdir, run.id));
  assert.ok(partial.length >= 3 && partial.length < N, `aborted mid-run (${partial.length}/${N})`);
  assert.equal((await ledger.query(pdir, { type: "run.aborted" })).length, 0,
    "the engine ledgers only budget-cap aborts; a human abort is the routes layer's event");

  control = null;
  const done = await executeRun(SLUG, run.id, { dir });
  assert.equal(done.status, "complete");
  const lines = await readNdjson(outputsFile(pdir, run.id));
  assert.equal(lines.length, N);
  assertExactlyOnce(lines);
});

test("executeRun: a second identical run is 100% cache hits and $0 incremental cost; re-executing a complete run is a no-op", async (t) => {
  const N = 30;
  const { dir, project, pdir } = await setup(t, { units: makeUnits(N), instruments: [judgeInstrument()] });
  const adapter = mockAdapter(project, { accuracy: 1.0 });
  patchPricing(t, adapter); // nonzero pricing makes "$0 incremental" a real assertion

  const run1 = await createRun(project, { instrumentId: "inst_j", corpusId: "c1" }, { dir });
  const done1 = await executeRun(SLUG, run1.id, { dir });
  assert.equal(done1.status, "complete");
  assert.ok(done1.cost.actualUSD > 0, "first run paid for model calls");

  // re-executing the COMPLETED run is idempotent
  const again = await executeRun(SLUG, run1.id, { dir });
  assert.equal(again.status, "complete");
  assert.equal((await readNdjson(outputsFile(pdir, run1.id))).length, N);

  // a fresh run over the same (units, versionHash, snapshot) hits the cache
  const run2 = await createRun(project, { instrumentId: "inst_j", corpusId: "c1" }, { dir });
  const done2 = await executeRun(SLUG, run2.id, { dir });
  assert.equal(done2.status, "complete");
  assert.equal(done2.cost.actualUSD, 0, "cache hits are $0");
  assert.equal(done2.cost.inputTokens, 0);
  const lines2 = await readNdjson(outputsFile(pdir, run2.id));
  assert.equal(lines2.length, N);
  for (const l of lines2) assert.equal(l.cacheHit, true, "every output is a cache hit");
  // and the verdicts are byte-identical to the first run's
  const byUnit1 = new Map((await readNdjson(outputsFile(pdir, run1.id))).map((l) => [l.unitId, l.label]));
  for (const l of lines2) assert.equal(l.label, byUnit1.get(l.unitId));
});

// ---------------------------------------------------------------- quarantine

test("executeRun: SCHEMA_INVALID after repairs quarantines the unit; the run continues", async (t) => {
  const N = 12;
  const units = makeUnits(N);
  const poison = units[5];
  const inst = judgeInstrument({}, { promptTemplate: `[[handler:badjson]]\n${DEFAULT_TEMPLATE}` });
  const { dir, project, pdir } = await setup(t, { units, instruments: [inst] });
  const adapter = mockAdapter(project, { accuracy: 1.0 });
  adapter.setHandler("badjson", (req) => {
    // search ALL messages: during the repair loop the LAST user message is
    // the repair instruction, but the unit block is still in the transcript
    const all = req.messages.map((m) => m.content).join("\n");
    const unitText = all.match(/<unit>\n([\s\S]*?)\n<\/unit>/)?.[1] ?? "";
    if (unitText === poison.text) return { garbage: true }; // schema-invalid, every attempt incl. repairs
    return { rationale: "scripted", label: ORACLE(unitText), confidence: 0.9 };
  });
  t.after(() => adapter.handlers.delete("badjson"));

  const run = await createRun(project, { instrumentId: "inst_j", corpusId: "c1" }, { dir });
  let lastTick = null;
  const done = await executeRun(SLUG, run.id, { dir, onTick: (s) => { lastTick = s; } });

  assert.equal(done.status, "complete", "quarantine never kills the run");
  // quarantine entries carry their reasons: {unitId, code, message} — the
  // researcher must see WHY a unit vanished, not just that it did
  assert.equal(done.quarantine.length, 1);
  const q = done.quarantine[0];
  assert.equal(q.unitId, poison.id);
  assert.equal(q.code, "SCHEMA_INVALID");
  assert.ok(typeof q.message === "string" && q.message.length > 0, "the failure message rides along");
  assert.ok(q.message.length <= 200, "message is trimmed to ≤200 chars");
  // …and the persisted run record carries the same rich shape
  const onDisk = (await loadProject(SLUG, dir)).runs[0];
  assert.deepEqual(onDisk.quarantine, done.quarantine);
  const lines = await readNdjson(outputsFile(pdir, run.id));
  assert.equal(lines.length, N - 1);
  assert.ok(!lines.some((l) => l.unitId === poison.id), "no output line for the quarantined unit");
  assertExactlyOnce(lines);
  // the quarantine warning was visible in live telemetry (state clears at
  // complete) and now carries the taxonomy code too
  assert.ok(lastTick.warnings.some((w) => w.kind === "quarantine" && w.unitId === poison.id && w.code === "SCHEMA_INVALID"));
});

test("executeRun: legacy string quarantine entries (old run records) normalize on read — resume never breaks", async (t) => {
  const N = 6;
  const { dir, project, pdir } = await setup(t, { units: makeUnits(N), instruments: [judgeInstrument()] });
  mockAdapter(project, { accuracy: 1.0 });
  const run = await createRun(project, { instrumentId: "inst_j", corpusId: "c1" }, { dir });
  // Simulate a record written by the pre-reasons engine: bare unitId strings
  // (with a duplicate — the old Set used to absorb those). u_0003 already has a
  // durable final line on disk, so resume sees it DONE and does not re-run it —
  // the legacy quarantine entry stays and must normalize. (A unit that instead
  // SUCCEEDS on resume is correctly cleared from quarantine; that path is
  // covered by the quarantine-cleared-on-resume test below.)
  const u3 = makeUnits(N).find((u) => u.id === "u_0003");
  const u3File = outputsFile(pdir, run.id);
  await mkdir(path.dirname(u3File), { recursive: true });
  await writeFile(u3File, JSON.stringify({ unitId: u3.id, juror: run.versionHash, label: ORACLE(u3.text), rationale: "legacy" }) + "\n", "utf8");
  await updateProject(SLUG, (p) => {
    p.runs[0].status = "paused";
    p.runs[0].quarantine = ["u_0003", "u_0003"];
  }, dir);

  const done = await executeRun(SLUG, run.id, { dir });
  assert.equal(done.status, "complete");
  assert.deepEqual(
    done.quarantine,
    [{ unitId: "u_0003", code: null, message: null }],
    "legacy strings normalize to {unitId, code: null, message: null}, deduped by unitId",
  );
  const onDisk = (await loadProject(SLUG, dir)).runs[0];
  assert.deepEqual(onDisk.quarantine, done.quarantine, "the normalized shape is what persists");
});

// ---------------------------------------------------------------- panels

test("executeRun: panel run writes per-juror lines AND an aggregate line per unit", async (t) => {
  const N = 21;
  const jurors = [judgePayload({ params: { temperature: 0, maxTokens: 64, seed: "j1" } }),
                  judgePayload({ params: { temperature: 0, maxTokens: 64, seed: "j2" } }),
                  judgePayload({ params: { temperature: 0, maxTokens: 64, seed: "j3" } })];
  const inst = createInstrument({
    id: "inst_p", constructId: "c_bin", kind: "panel", name: "panel",
    payload: { jurors, aggregation: "majority" },
  });
  const { dir, project, pdir } = await setup(t, { units: makeUnits(N), instruments: [inst] });
  mockAdapter(project, { accuracy: 0.8 });

  const run = await createRun(project, { instrumentId: "inst_p", corpusId: "c1" }, { dir });
  assert.equal(run.model, "mock-1+mock-1+mock-1");
  const done = await executeRun(SLUG, run.id, { dir });
  assert.equal(done.status, "complete");

  const lines = await readNdjson(outputsFile(pdir, run.id));
  assert.equal(lines.length, N * 4, "3 juror lines + 1 aggregate line per unit");
  assertExactlyOnce(lines);
  const hashes = jurors.map((j) => instrumentVersionHash(j));
  for (const u of makeUnits(N)) {
    const mine = lines.filter((l) => l.unitId === u.id);
    assert.equal(mine.length, 4);
    const agg = mine.find((l) => l.juror === "aggregate");
    assert.ok(agg, "aggregate line present");
    assert.ok(typeof agg.entropy === "number");
    for (const h of hashes) assert.ok(mine.some((l) => l.juror === h), "every juror wrote a line");
    // aggregate = majority of the three juror labels (or flagged on a tie —
    // impossible with 3 binary jurors)
    const labels = mine.filter((l) => l.juror !== "aggregate").map((l) => l.label);
    const yes = labels.filter((l) => l === "yes").length;
    assert.equal(agg.label, yes >= 2 ? "yes" : "no");
  }
});

// ---------------------------------------------------------------- escalation

test("executeRun: escalation predicate marks atypically long units; the Director callback's replacement is recorded", async (t) => {
  const units = makeUnits(20);
  units[7] = { ...units[7], text: ("the one enormous unit about pay salary ").repeat(12) }; // ≫ p99
  const big = units[7];
  const { dir, project, pdir } = await setup(t, { units, instruments: [judgeInstrument()] });
  mockAdapter(project, { accuracy: 1.0 });

  // with a Director second-opinion callback: replacement recorded
  const run = await createRun(project, { instrumentId: "inst_j", corpusId: "c1" }, { dir });
  const escalatedSeen = [];
  const done = await executeRun(SLUG, run.id, {
    dir,
    escalate: async (unit, output) => {
      escalatedSeen.push({ unitId: unit.id, output });
      return { label: "no", rationale: "director second opinion", escalatedBy: "director" };
    },
  });
  assert.equal(done.status, "complete");
  assert.equal(done.escalation.count, 1);
  assert.deepEqual(escalatedSeen.map((e) => e.unitId), [big.id]);

  const lines = await readNdjson(outputsFile(pdir, run.id));
  const line = lines.find((l) => l.unitId === big.id);
  assert.equal(line.escalated, true);
  assert.equal(line.label, "no", "the replacement label is what lands in outputs");
  assert.equal(line.rationale, "director second opinion");
  assert.equal(line.juror, done.versionHash, "the worker's juror hash stays on the line — resume keys on it");
  assert.equal(line.escalatedBy, "director", "the replacement's provenance marker is copied onto the line");
  assert.equal(lines.filter((l) => l.escalated).length, 1);

  const summary = await ledger.query(pdir, { type: "run.escalation_summary" });
  assert.equal(summary.length, 1);
  assert.equal(summary[0].payload.count, 1);

  // without a callback: marked for the human queue, original label kept
  const run2 = await createRun(project, { instrumentId: "inst_j", corpusId: "c1" }, { dir });
  await executeRun(SLUG, run2.id, { dir });
  const line2 = (await readNdjson(outputsFile(pdir, run2.id))).find((l) => l.unitId === big.id);
  assert.equal(line2.escalated, true);
  assert.equal(line2.label, "yes", "no Director → original verdict stays, just flagged");
  assert.equal(line2.escalatedBy, undefined, "no second opinion → no provenance marker");
});

// ---------------------------------------------------------------- edges

test("executeRun: empty corpus completes immediately; missing run is NOT_FOUND", async (t) => {
  const { dir, project } = await setup(t, { units: [], instruments: [judgeInstrument()] });
  mockAdapter(project);
  const run = await createRun(project, { instrumentId: "inst_j", corpusId: "c1" }, { dir });
  assert.deepEqual(run.checkpoint, { done: 0, total: 0 });
  const done = await executeRun(SLUG, run.id, { dir });
  assert.equal(done.status, "complete");
  await assert.rejects(() => executeRun(SLUG, "run_missing", { dir }), (e) => e.code === "NOT_FOUND");
});

test("executeRun: unitFilter meta.dept=sales judges only matching units", async (t) => {
  const N = 20;
  const { dir, project, pdir } = await setup(t, { units: makeUnits(N), instruments: [judgeInstrument()] });
  mockAdapter(project, { accuracy: 1.0 });
  const run = await createRun(project, { instrumentId: "inst_j", corpusId: "c1", unitFilter: "meta.dept=sales" }, { dir });
  assert.equal(run.checkpoint.total, 10);
  const done = await executeRun(SLUG, run.id, { dir });
  assert.equal(done.status, "complete");
  const lines = await readNdjson(outputsFile(pdir, run.id));
  assert.equal(lines.length, 10);
  const sales = new Set(makeUnits(N).filter((u) => u.meta.dept === "sales").map((u) => u.id));
  for (const l of lines) assert.ok(sales.has(l.unitId));
});

// ---------------------------------------------------------------- runEphemeral

test("runEphemeral: outputs without persistence; cache-aware; seedOffset decorrelates", async (t) => {
  const units = makeUnits(15);
  const { dir, project, pdir } = await setup(t, { units, instruments: [judgeInstrument()] });
  const adapter = mockAdapter(project, { accuracy: 1.0 });
  patchPricing(t, adapter);
  const inst = judgeInstrument();

  const first = await runEphemeral(project, inst, units, { dir });
  assert.equal(first.outputs.length, 15);
  assert.deepEqual(first.quarantine, []);
  assert.ok(first.cost.actualUSD > 0);
  assert.ok(!existsSync(path.join(pdir, "runs")), "ephemeral runs persist nothing under runs/");
  for (const o of first.outputs) assert.equal(o.label, ORACLE(units.find((u) => u.id === o.unitId).text));

  // identical second call → 100% cache hits, $0
  const second = await runEphemeral(project, inst, units, { dir });
  assert.equal(second.cost.actualUSD, 0);
  for (const o of second.outputs) assert.equal(o.cacheHit, true);

  // distinct seedOffset → its own cache namespace and its own output stream.
  // Outputs land in completion order (concurrency) — compare BY UNIT.
  const byUnit = (res) => res.outputs.slice().sort((x, y) => (x.unitId < y.unitId ? -1 : 1)).map((o) => `${o.unitId}:${o.label}`).join(",");
  adapter.setAccuracy(0.5);
  const a = await runEphemeral(project, inst, units, { dir, seedOffset: "s1" });
  const b = await runEphemeral(project, inst, units, { dir, seedOffset: "s2" });
  assert.ok(a.outputs.some((o) => !o.cacheHit), "new seed is not the old cache");
  assert.notEqual(byUnit(a), byUnit(b), "distinct seeds yield distinct streams");
  // and each seed's stream is itself cached + reproducible
  const a2 = await runEphemeral(project, inst, units, { dir, seedOffset: "s1" });
  assert.equal(byUnit(a2), byUnit(a));
  assert.equal(a2.cost.actualUSD, 0);
});

test("runEphemeral: quarantine entries carry {unitId, code, message} (previews show the reason, not an empty list)", async (t) => {
  const units = makeUnits(6);
  const poison = units[2];
  const inst = judgeInstrument({}, { promptTemplate: `[[handler:badjson-eph]]\n${DEFAULT_TEMPLATE}` });
  const { dir, project } = await setup(t, { units, instruments: [inst] });
  const adapter = mockAdapter(project, { accuracy: 1.0 });
  adapter.setHandler("badjson-eph", (req) => {
    const all = req.messages.map((m) => m.content).join("\n");
    const unitText = all.match(/<unit>\n([\s\S]*?)\n<\/unit>/)?.[1] ?? "";
    if (unitText === poison.text) return { garbage: true }; // schema-invalid on every attempt incl. repairs
    return { rationale: "scripted", label: ORACLE(unitText), confidence: 0.9 };
  });
  t.after(() => adapter.handlers.delete("badjson-eph"));

  const res = await runEphemeral(project, inst, units, { dir });
  assert.equal(res.outputs.length, 5, "the other units still produce outputs");
  assert.equal(res.quarantine.length, 1);
  assert.equal(res.quarantine[0].unitId, poison.id);
  assert.equal(res.quarantine[0].code, "SCHEMA_INVALID");
  assert.ok(typeof res.quarantine[0].message === "string" && res.quarantine[0].message.length > 0);
  assert.ok(res.quarantine[0].message.length <= 200);
});

test("runEphemeral: capUSD stops early with partial outputs (aborted: true)", async (t) => {
  const units = makeUnits(40);
  const { dir, project } = await setup(t, { units, instruments: [judgeInstrument()] });
  const adapter = mockAdapter(project, { accuracy: 1.0 });
  patchPricing(t, adapter);
  const res = await runEphemeral(project, judgeInstrument(), units, { dir, capUSD: 0.005 });
  assert.equal(res.aborted, true);
  assert.ok(res.outputs.length > 0 && res.outputs.length < 40);
  assert.ok(res.cost.actualUSD >= 0.005);
});

// ---------------------------------------------------------------- stability

test("stabilityCheck: deterministic instrument (accuracy 1.0) → alpha 1, pass; ledger instrument.stability", async (t) => {
  const units = makeUnits(30);
  const inst = judgeInstrument();
  const { dir, project, pdir } = await setup(t, { units, instruments: [inst] });
  mockAdapter(project, { accuracy: 1.0 });

  const res = await stabilityCheck(project, inst, units, { k: 3, dir });
  assert.equal(res.alpha, 1);
  assert.equal(res.pass, true);
  assert.equal(res.runs.length, 3);
  for (const r of res.runs) {
    assert.equal(r.outputs.length, 30);
    assert.match(r.seedOffset, /^stability:\d$/);
  }
  const ev = await ledger.query(pdir, { type: "instrument.stability" });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.pass, true);
  assert.equal(ev[0].payload.k, 3);
  assert.equal(ev[0].refs.instrumentId, inst.id);
});

test("stabilityCheck: noisy instrument (accuracy 0.6) → distinct seeds expose instability, alpha < 0.8", async (t) => {
  const units = makeUnits(60);
  const inst = judgeInstrument();
  const { dir, project } = await setup(t, { units, instruments: [inst] });
  mockAdapter(project, { accuracy: 0.6 });

  const res = await stabilityCheck(project, inst, units, { k: 3, n: 50, dir });
  assert.ok(res.alpha < 0.8, `noisy judge must fail stability (alpha ${res.alpha})`);
  assert.equal(res.pass, false);
  assert.equal(res.runs[0].outputs.length, 50);
  // the reruns genuinely differ — distinct req.seed per rerun (sort by unit:
  // completion order is concurrency-dependent)
  const sorted = (i) => res.runs[i].outputs.slice().sort((x, y) => (x.unitId < y.unitId ? -1 : 1)).map((o) => `${o.unitId}:${o.label}`).join(",");
  assert.notEqual(sorted(0), sorted(1));
});

test("stabilityCheck: sample is capped at min(n, 100, units) and empty units throw", async (t) => {
  const units = makeUnits(150);
  const inst = judgeInstrument();
  const { dir, project } = await setup(t, { units, instruments: [inst] });
  mockAdapter(project, { accuracy: 1.0 });
  const res = await stabilityCheck(project, inst, units, { k: 2, n: 500, dir });
  assert.equal(res.runs[0].outputs.length, 100, "default sample caps at 100");
  await assert.rejects(() => stabilityCheck(project, inst, [], { dir }), (e) => e.code === "VALIDATION");
});

// ---------------------------------------------------------------- monitor

test("monitor: degenerate-output warning fires once after 100+ outputs of one label", async (t) => {
  const N = 120;
  const { dir, project } = await setup(t, { units: makeUnits(N, { isPay: () => false }), instruments: [judgeInstrument()] });
  mockAdapter(project, { accuracy: 1.0 }); // oracle says "no" for every unit
  const run = await createRun(project, { instrumentId: "inst_j", corpusId: "c1" }, { dir });
  let lastTick = null;
  await executeRun(SLUG, run.id, { dir, onTick: (s) => { lastTick = s; } });
  const degen = lastTick.warnings.filter((w) => w.kind === "degenerate-output");
  assert.equal(degen.length, 1, "warned exactly once");
  assert.equal(degen[0].label, "no");
  assert.ok(degen[0].share > 0.95);
});

test("monitor: runState returns null for unknown runs; tracks cost and escalations", () => {
  assert.equal(monitor.runState("run_unknown"), null);
  monitor.track("run_m1", { total: 5 });
  monitor.recordOutput("run_m1", { label: "yes", escalated: true });
  monitor.addCost("run_m1", 0.25);
  const s = monitor.runState("run_m1");
  assert.equal(s.done, 1);
  assert.equal(s.escalations, 1);
  assert.equal(s.costUSD, 0.25);
  assert.deepEqual(s.labelDist, { yes: 1 });
  monitor.clearRun("run_m1");
  assert.equal(monitor.runState("run_m1"), null);
});

test("monitor: drift tripwire warns when run-time agreement on gold drops below the certificate", async (t) => {
  const N = 30;
  const units = makeUnits(N);
  const inst = judgeInstrument();
  freeze(inst, {
    frozenAt: "2026-06-05T00:00:00.000Z",
    goldsetId: "gs_1",
    agreement: { n: 20, percent: 1.0 },
    humanAgreement: { n: 20, percent: 0.95 },
    versionHash: inst.versionHash,
    modelPinned: true,
  });
  const { dir, project } = await setup(t, { units, instruments: [inst] });

  // calibration-era accuracy was 1.0 (the certificate); the served model has
  // silently degraded to 0.2 by run time
  mockAdapter(project, { accuracy: 0.2 });

  // 4 gold units → each re-judge is one quick pool round, so its warning is
  // visible to the many ticks that follow the crossing (state clears at
  // complete — drift warnings are observed through live telemetry).
  const goldOutputs = makeUnits(4).map((u) => ({ unit: u, label: ORACLE(u.text) }));
  const run = await createRun(project, { instrumentId: "inst_j", corpusId: "c1" }, { dir });
  // {dir} threads the bundle dir through driftTick's runEphemeral — without it
  // the re-judge cache pollutes the DEFAULT projects dir (<repo>/projects).
  monitor.armDriftTripwire(run.id, { project, goldOutputs, instrument: inst, every: 10, threshold: 0.15, dir });

  const warningsSeen = new Map(); // message → warning, union across ticks
  await executeRun(SLUG, run.id, {
    dir,
    onTick: (s) => { for (const w of s.warnings) warningsSeen.set(w.message, w); },
  });
  const drift = [...warningsSeen.values()].filter((w) => w.kind === "drift");
  assert.ok(drift.length >= 1, "drift warning fired");
  assert.ok(drift[0].agreement < 0.85, `re-judged agreement ${drift[0].agreement} reflects the degraded model`);
  assert.equal(drift[0].baseline, 1.0);
  assert.ok(!existsSync(path.join(projectsDir(), SLUG)),
    "the drift re-judge must not write into the default projects dir (BUG-2: cache pollution under <repo>/projects)");
  assert.equal(monitor.runState(run.id), null, "complete run clears monitor state (and its tripwire)");
});

test("monitor: armDriftTripwire validates its inputs", async (t) => {
  const inst = judgeInstrument();
  const { project } = await setup(t, { units: makeUnits(3), instruments: [inst] });
  assert.throws(() => monitor.armDriftTripwire("r", { project, instrument: inst, goldOutputs: [] }), (e) => e.code === "VALIDATION");
  assert.throws(
    () => monitor.armDriftTripwire("r", { project, instrument: inst, goldOutputs: [{ unit: makeUnits(1)[0], label: "yes" }] }),
    (e) => e.code === "VALIDATION", // no certificate, no explicit baseline
  );
});
