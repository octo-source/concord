// Run-integrity regression suite (June 2026 accuracy sweep — RUN-ENGINE /
// ANALYSES cluster). Pins, red-first:
//   1  version-hash orphaning: exports/analyses/resume key final verdicts on
//      run.versionHash (the hash the run STARTED under), not the unfrozen
//      instrument's current hash.
//   2  Director escalation crash path: an infrastructure fault inside the
//      second opinion PAUSES the run (resumable) instead of rejecting the
//      worker pool; deterministic faults skip the second opinion and the run
//      completes; a throw that escapes the engine before terminal persistence
//      still settles the disk record (never stuck "running").
//   3  run.error {code, message} persists on failed runs (the detail payload
//      the client renders).
//   4  corrected analyses distinguish raw shares from corrected cells —
//      distribution entries carry corrected: false.
//   5  quarantined units tick the live monitor: done reaches total.
//   6  completed runs persist labelDist (calibration's planning-pe reads it).
//   7  Director concurrence is stamped escalatedBy: "director-concurred" —
//      distinguishable from never-reviewed.
//   8  evidence cells cap at 100 ids while results carry the TRUE n
//      (distribution[*].n, triangulation divergentN).
//  10  uncertainty-design gold never mints level "corrected" (π is nominal);
//      the analysis carries a note saying so.
//  11  continuous constructs render their declared scale bounds in the
//      prompt and enforce them in the response schema.
//  12  Director schema-repair attempts are metered (every attempt bills).
//
// Hermetic: MockModel only, bundles under a temp CONCORD_PROJECTS_DIR (route
// handlers resolve the default projects dir from the env var).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as engineMod from "../../server/runs/engine.js";
import * as monitor from "../../server/runs/monitor.js";
import runsRoutes from "../../server/routes/runs.js";
import analysesRoutes from "../../server/routes/analyses.js";
import evidenceRoutes from "../../server/routes/evidence.js";
import {
  outputSchemaFor,
  jsonSchemaFor,
  assemble,
  DEFAULT_TEMPLATE,
} from "../../server/instruments/judge.js";
import { callDirector, directorCosts } from "../../server/director/director.js";
import { makeEscalator } from "../../server/director/escalate.js";
import {
  createProject,
  createConstruct,
  createInstrument,
  createGoldSet,
  versionInstrument,
  instrumentVersionHash,
} from "../../server/core/objects.js";
import {
  saveProject,
  loadProject,
  updateProject,
  readNdjson,
  projectDir,
} from "../../server/core/store.js";
import * as ledger from "../../server/core/ledger.js";
import { getAdapter } from "../../server/providers/registry.js";
import { ConcordError } from "../../server/core/errors.js";

// ---------------------------------------------------------------- harness

let tmpRoot;
before(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "concord-integrity-"));
  process.env.CONCORD_PROJECTS_DIR = tmpRoot;
});
after(async () => {
  delete process.env.CONCORD_PROJECTS_DIR;
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

const mock = getAdapter({ privacyMode: "open" }, "mock").adapter;
const ORACLE = (text) => (text.includes("pay salary") ? "yes" : "no");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const binaryConstruct = (id = "c_bin") =>
  createConstruct({
    id,
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
  createInstrument({
    id: "inst_j",
    constructId: "c_bin",
    kind: "judge",
    name: "judge",
    payload: judgePayload(payloadExtra),
    ...extra,
  });

// Equal-length unit texts: the p99-length escalation predicate stays quiet
// unless a test plants a long unit on purpose.
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

// Project bundle in the env projects dir (route handlers read the default).
async function setup(
  slug,
  { units, instruments = [], constructs = [binaryConstruct()], director = null, id } = {},
) {
  const project = createProject({ name: slug, slug, privacyMode: "open", ...(id ? { id } : {}) });
  project.director = director;
  project.corpora.push({ id: "c1", name: "corpus" });
  project.constructs.push(...constructs);
  project.instruments.push(...instruments);
  await saveProject(project);
  const file = path.join(projectDir(slug), "corpora", "c1", "units.ndjson");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    units.length ? units.map((u) => JSON.stringify(u)).join("\n") + "\n" : "",
    "utf8",
  );
  return { project, pdir: projectDir(slug) };
}

const outputsFile = (slug, runId) => path.join(projectDir(slug), "runs", runId, "outputs.ndjson");

function assertExactlyOnce(lines) {
  const seen = new Set();
  for (const l of lines) {
    const k = `${l.unitId}|${l.juror}`;
    assert.ok(!seen.has(k), `duplicate output line for ${k}`);
    seen.add(k);
  }
}

function routeHandler(routes, method, pattern) {
  const r = routes.find((x) => x.method === method && x.pattern === pattern);
  assert.ok(r, `route ${method} ${pattern} exists`);
  return r.handler;
}

const fakeRes = () => ({
  code: null,
  headers: null,
  body: null,
  writeHead(code, headers) {
    this.code = code;
    this.headers = headers;
  },
  end(body) {
    this.body = body;
  },
});

// Bump the unfrozen instrument's versionHash the same way the update route
// does (versionInstrument: new payload → new hash, evidence reset).
async function editInstrument(slug, instrumentId) {
  let before = null;
  let afterHash = null;
  await updateProject(slug, (p) => {
    const inst = p.instruments.find((i) => i.id === instrumentId);
    before = inst.versionHash;
    versionInstrument(inst, {
      ...inst.payload,
      promptTemplate: `${inst.payload.promptTemplate}\nEDITED AFTER THE RUN`,
    });
    afterHash = inst.versionHash;
  });
  assert.notEqual(afterHash, before, "the edit really bumped the hash");
  return { before, after: afterHash };
}

// gold/<id>.json + project.goldsets registry entry, complete with π. Two
// coders in full agreement: consensus gold under both the historical
// single-coder reading and the current two-voice consensus rule.
async function plantGoldset(slug, { id, constructId, design, units, labelOf, pi }) {
  const labels = Object.fromEntries(units.map((u) => [u.id, labelOf(u)]));
  const gs = createGoldSet({
    id,
    constructId,
    tier: "gold",
    design,
    status: "complete",
    sample: units.map((u) => ({ unitId: u.id, pi })),
    coders: [
      { coderId: "h1", labels },
      { coderId: "h2", labels: { ...labels } },
    ],
  });
  const file = path.join(projectDir(slug), "gold", `${gs.id}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(gs, null, 2), "utf8");
  await updateProject(slug, (p) => {
    p.goldsets.push({ id: gs.id, constructId, tier: "gold", status: "complete", design });
  });
  return gs;
}

// =============================================================================
// 1 — version-hash orphaning
// =============================================================================

test("fix 1: instrument edit after a complete run — export.csv still carries labels, analyses still assemble rows, finalJurorOfRun pins run.versionHash", async () => {
  const slug = "vh-export";
  const units = makeUnits(12);
  const { project } = await setup(slug, { units, instruments: [judgeInstrument()] });
  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);

  const run = await engineMod.createRun(project, { instrumentId: "inst_j", corpusId: "c1" });
  const done = await engineMod.executeRun(slug, run.id);
  assert.equal(done.status, "complete");
  const originalHash = done.versionHash;

  // the unfrozen instrument mutates its hash on every edit
  await editInstrument(slug, "inst_j");
  const fresh = await loadProject(slug);
  const editedInstrument = fresh.instruments.find((i) => i.id === "inst_j");
  assert.notEqual(editedInstrument.versionHash, originalHash);

  // the run-aware juror key pins the hash the run STARTED under
  assert.equal(typeof engineMod.finalJurorOfRun, "function", "engine exports finalJurorOfRun");
  assert.equal(engineMod.finalJurorOfRun(done, editedInstrument), originalHash);
  // panel finals stay keyed on the constant aggregate line
  assert.equal(
    engineMod.finalJurorOfRun({ versionHash: "vh_run" }, { kind: "panel", versionHash: "vh_now" }),
    "aggregate",
    "panel semantics intact",
  );

  // export.csv: every unit row still carries its label
  const res = fakeRes();
  await routeHandler(runsRoutes, "GET", "/api/projects/:p/runs/:r/export.csv")({}, res, {
    p: slug,
    r: run.id,
  });
  assert.equal(res.code, 200);
  const rows = String(res.body).trim().split("\n");
  assert.equal(rows.length, 1 + units.length);
  for (const row of rows.slice(1)) {
    assert.match(row, /,(yes|no),/, `exported row carries its label after the edit: ${row}`);
  }

  // analyses: assembleRows still finds the labeled outputs
  const analysis = await routeHandler(analysesRoutes, "POST", "/api/projects/:p/analyses")(
    { body: { kind: "descriptive", spec: { runId: run.id } } },
    null,
    { p: slug },
  );
  assert.equal(analysis.results.n, units.length, "every labeled unit assembles after the edit");
  assert.ok(Object.keys(analysis.results.distribution).length >= 1);
});

test("fix 1: resume after an edit sees done units (no re-billing) and writes every line under the run's original hash", async () => {
  const slug = "vh-resume";
  const N = 30;
  const { project, pdir } = await setup(slug, {
    units: makeUnits(N),
    instruments: [judgeInstrument()],
  });
  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);

  const run = await engineMod.createRun(project, { instrumentId: "inst_j", corpusId: "c1" });
  const originalHash = run.versionHash;

  // pause mid-run, then edit the instrument before resuming
  let control = null;
  let ticks = 0;
  const paused = await engineMod.executeRun(slug, run.id, {
    shouldStop: () => control,
    onTick: () => {
      ticks += 1;
      if (ticks === 5) control = "pause";
    },
  });
  assert.equal(paused.status, "paused");
  const partial = await readNdjson(outputsFile(slug, run.id));
  assert.ok(partial.length >= 5 && partial.length < N, `paused mid-run (${partial.length}/${N})`);

  await editInstrument(slug, "inst_j");

  const done = await engineMod.executeRun(slug, run.id);
  assert.equal(done.status, "complete");
  const lines = await readNdjson(outputsFile(slug, run.id));
  assert.equal(
    lines.length,
    N,
    "resume fills exactly the missing units — no re-judging of done units",
  );
  assertExactlyOnce(lines);
  for (const l of lines) {
    assert.equal(
      l.juror,
      originalHash,
      `every line keys the hash the run started under (got ${l.juror})`,
    );
  }
  const started = await ledger.query(pdir, { type: "run.started" });
  assert.equal(started.length, 2);
  assert.equal(
    started[1].payload.pendingUnits,
    N - partial.length,
    "resume's done-set keys on run.versionHash — done units stay done after the edit",
  );
});

// =============================================================================
// 2 — Director escalation crash path
// =============================================================================

test("fix 2a: a Director infrastructure fault (unpooled 429) pauses the run — resumable, persisted, the pool never rejects", async () => {
  const slug = "esc-pause";
  const units = makeUnits(20);
  units[7] = { ...units[7], text: "the one enormous unit about pay salary ".repeat(12) }; // ≫ p99 → escalates
  const { project } = await setup(slug, { units, instruments: [judgeInstrument()] });
  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);

  const run = await engineMod.createRun(project, { instrumentId: "inst_j", corpusId: "c1" });
  const paused = await engineMod.executeRun(slug, run.id, {
    escalate: async () => {
      throw new ConcordError("PROVIDER_HTTP", "POST /director → HTTP 429", {
        status: 429,
        retryAfterMs: 1000,
      });
    },
  });
  assert.equal(
    paused.status,
    "paused",
    "Director PROVIDER_* faults are pause-class, never a pool rejection",
  );
  assert.equal(paused.error.code, "PROVIDER_HTTP");

  const onDisk = (await loadProject(slug)).runs[0];
  assert.equal(onDisk.status, "paused", "the resumable status is persisted");
  assert.equal(onDisk.error.code, "PROVIDER_HTTP");

  const partial = await readNdjson(outputsFile(slug, run.id));
  assert.ok(
    !partial.some((l) => l.unitId === units[7].id),
    "the escalating unit's final line is NOT appended — resume re-attempts the second opinion",
  );

  // Director healthy again → resume completes off the cached worker verdicts
  const done = await engineMod.executeRun(slug, run.id, { escalate: async () => null });
  assert.equal(done.status, "complete");
  const lines = await readNdjson(outputsFile(slug, run.id));
  assert.equal(lines.length, units.length);
  assertExactlyOnce(lines);
  assert.equal(lines.find((l) => l.unitId === units[7].id).escalated, true);
});

test("fix 2a: a deterministic Director fault (SCHEMA_INVALID) skips the second opinion — worker verdict stands, run completes, warning recorded", async () => {
  const slug = "esc-skip";
  const units = makeUnits(20);
  units[7] = { ...units[7], text: "the one enormous unit about pay salary ".repeat(12) };
  const { project } = await setup(slug, { units, instruments: [judgeInstrument()] });
  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);

  const run = await engineMod.createRun(project, { instrumentId: "inst_j", corpusId: "c1" });
  let lastTick = null;
  const done = await engineMod.executeRun(slug, run.id, {
    onTick: (s) => {
      lastTick = s;
    },
    escalate: async () => {
      throw new ConcordError(
        "SCHEMA_INVALID",
        "second opinion failed schema validation after repairs",
        {},
      );
    },
  });
  assert.equal(
    done.status,
    "complete",
    "a malformed second opinion never invalidates the worker's verdict",
  );
  assert.equal(
    done.escalation.count,
    1,
    "the unit still counts as escalated (the predicate fired)",
  );
  const line = (await readNdjson(outputsFile(slug, run.id))).find((l) => l.unitId === units[7].id);
  assert.equal(line.escalated, true);
  assert.equal(line.label, "yes", "the worker verdict stands");
  assert.equal(line.escalatedBy, undefined, "no second opinion landed — no provenance marker");
  assert.ok(
    lastTick.warnings.some((w) => w.kind === "escalation-failed" && w.unitId === units[7].id),
    "the failed second opinion is visible in live telemetry",
  );
});

test("fix 2b: a throw that escapes the engine before terminal persistence still settles the disk record at failed (never stuck running)", async () => {
  const slug = "esc-backstop";
  const { project } = await setup(slug, { units: makeUnits(6), instruments: [judgeInstrument()] });
  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);
  const run = await engineMod.createRun(project, { instrumentId: "inst_j", corpusId: "c1" });

  // sabotage: a kind the engine cannot run — jurorsOf throws inside
  // buildContext, BEFORE the engine persists anything
  await updateProject(slug, (p) => {
    p.instruments.find((i) => i.id === "inst_j").kind = "rule";
  });

  const out = await routeHandler(runsRoutes, "POST", "/api/projects/:p/runs/:r/resume")({}, null, {
    p: slug,
    r: run.id,
  });
  assert.equal(
    out.status,
    "running",
    "the route answers immediately; the failure lands in the background",
  );

  let settled = null;
  for (let i = 0; i < 60; i++) {
    settled = (await loadProject(slug)).runs[0];
    if (settled.status !== "running") break;
    await sleep(50);
  }
  assert.equal(settled.status, "failed", "the disk record never sticks at running");
  assert.equal(settled.error.code, "VALIDATION");
  assert.ok(settled.error.message.length > 0);
});

// =============================================================================
// 3 — run.error persists into the detail payload
// =============================================================================

test("fix 3 (pin): a failed run persists run.error {code, message} in the project payload the detail screen reads", async (t) => {
  const slug = "err-pin";
  const { project } = await setup(slug, { units: makeUnits(6), instruments: [judgeInstrument()] });
  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);

  const proto = Object.getPrototypeOf(mock);
  mock.complete = async function patched(req) {
    const all = req.messages.map((m) => m.content).join("\n");
    if (all.includes("response 000"))
      throw new ConcordError("BOOM_TEST", "synthetic worker explosion", {});
    return proto.complete.call(this, req);
  };
  t.after(() => {
    delete mock.complete;
  });

  const run = await engineMod.createRun(project, { instrumentId: "inst_j", corpusId: "c1" });
  await assert.rejects(
    () => engineMod.executeRun(slug, run.id),
    (e) => e.code === "BOOM_TEST",
  );

  const onDisk = (await loadProject(slug)).runs[0];
  assert.equal(onDisk.status, "failed");
  assert.deepEqual(onDisk.error, { code: "BOOM_TEST", message: "synthetic worker explosion" });
});

// =============================================================================
// 4 — raw shares vs corrected cells: explicit provenance
// =============================================================================

test("fix 4: corrected descriptive analyses mark raw distribution entries corrected:false beside the DSL cells", async () => {
  const slug = "raw-vs-corrected";
  const units = makeUnits(30);
  const { project } = await setup(slug, { units, instruments: [judgeInstrument()] });
  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);

  const run = await engineMod.createRun(project, { instrumentId: "inst_j", corpusId: "c1" });
  await engineMod.executeRun(slug, run.id);
  await plantGoldset(slug, {
    id: "gs_srs",
    constructId: "c_bin",
    design: "srs",
    units: units.slice(0, 10),
    labelOf: (u) => ORACLE(u.text),
    pi: 10 / 30,
  });

  const analysis = await routeHandler(analysesRoutes, "POST", "/api/projects/:p/analyses")(
    { body: { kind: "descriptive", spec: { runId: run.id } } },
    null,
    { p: slug },
  );
  assert.equal(analysis.level, "corrected");
  assert.ok(analysis.results.cells?.length >= 1, "DSL cells present");
  assert.equal(analysis.results.estimator, "dslProportion");
  for (const [label, entry] of Object.entries(analysis.results.distribution)) {
    assert.equal(
      entry.corrected,
      false,
      `distribution["${label}"] is a RAW machine-label share and says so — the ◉ belongs to results.cells only`,
    );
    assert.equal(typeof entry.share, "number");
    assert.equal(typeof entry.n, "number");
  }
});

// =============================================================================
// 5 + 6 — quarantine progress ticks; persisted labelDist
// =============================================================================

test("fix 5: a quarantining unit still ticks the monitor — live done reaches total", async (t) => {
  const slug = "quar-tick";
  const N = 12;
  const units = makeUnits(N);
  const poison = units[5];
  const inst = judgeInstrument(
    {},
    { promptTemplate: `[[handler:integ-poison]]\n${DEFAULT_TEMPLATE}` },
  );
  const { project } = await setup(slug, { units, instruments: [inst] });
  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);
  mock.setHandler("integ-poison", (req) => {
    const all = req.messages.map((m) => m.content).join("\n");
    const unitText = all.match(/<unit>\n([\s\S]*?)\n<\/unit>/)?.[1] ?? "";
    if (unitText === poison.text) return { garbage: true }; // schema-invalid on every attempt
    return { rationale: "scripted", label: ORACLE(unitText), confidence: 0.9 };
  });
  t.after(() => mock.handlers.delete("integ-poison"));

  const run = await engineMod.createRun(project, { instrumentId: "inst_j", corpusId: "c1" });
  let lastTick = null;
  const done = await engineMod.executeRun(slug, run.id, {
    onTick: (s) => {
      lastTick = s;
    },
  });
  assert.equal(done.status, "complete");
  assert.equal(done.quarantine.length, 1);
  assert.equal(done.checkpoint.done, N);
  assert.equal(
    lastTick.done,
    N,
    "the live progress bar reaches total — quarantined units count toward progress (they are excluded from results, not from done)",
  );
  assert.equal(lastTick.total, N);
  assert.ok(
    !Object.keys(lastTick.labelDist).includes("undefined"),
    "no phantom label for the quarantined unit",
  );
});

test("fix 6: completed runs persist labelDist on the run record (shares sum to 1)", async () => {
  const slug = "labeldist";
  const N = 12;
  const { project } = await setup(slug, { units: makeUnits(N), instruments: [judgeInstrument()] });
  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);

  const run = await engineMod.createRun(project, { instrumentId: "inst_j", corpusId: "c1" });
  await engineMod.executeRun(slug, run.id);

  const onDisk = (await loadProject(slug)).runs[0];
  assert.ok(onDisk.labelDist && typeof onDisk.labelDist === "object", "run.labelDist persisted");
  assert.deepEqual(onDisk.labelDist, { yes: Math.ceil(N / 3), no: N - Math.ceil(N / 3) });
  const total = Object.values(onDisk.labelDist).reduce((s, x) => s + x, 0);
  const shareSum = Object.values(onDisk.labelDist).reduce((s, x) => s + x / total, 0);
  assert.ok(Math.abs(shareSum - 1) < 1e-9, "shares derived from the persisted counts sum to 1");
});

// =============================================================================
// 7 — concurrence provenance
// =============================================================================

test("fix 7: the Director reviewed and concurred → the written line is stamped escalatedBy: director-concurred", async () => {
  const slug = "esc-concur";
  const units = makeUnits(20);
  units[7] = { ...units[7], text: "the one enormous unit about pay salary ".repeat(12) }; // escalates; oracle says yes
  const { project } = await setup(slug, {
    units,
    instruments: [judgeInstrument()],
    director: {
      provider: "mock",
      model: "mock-1",
      snapshot: "mock-1",
      systemSuffix: "[[handler:integ-agree]]",
    },
  });
  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);
  mock.setHandler("integ-agree", () => ({
    rationale: "Independent read agrees: explicit salary complaint.",
    label: "yes", // same as the worker → concurrence
    confidence: 0.95,
    reason: "The codebook clearly covers explicit pay mentions.",
  }));

  const construct = project.constructs[0];
  const escalate = makeEscalator(project, construct);

  // the escalator's own return contract is unchanged: null on agreement
  const direct = await escalate(units[7], {
    unitId: units[7].id,
    juror: "vh",
    label: "yes",
    confidence: 0.4,
    rationale: "r",
  });
  assert.equal(
    direct,
    null,
    "escalate.js still returns null on concurrence (the engine stamps the provenance)",
  );

  const run = await engineMod.createRun(project, { instrumentId: "inst_j", corpusId: "c1" });
  const done = await engineMod.executeRun(slug, run.id, { escalate });
  assert.equal(done.status, "complete");
  assert.equal(done.escalation.count, 1);
  const line = (await readNdjson(outputsFile(slug, run.id))).find((l) => l.unitId === units[7].id);
  assert.equal(line.escalated, true);
  assert.equal(line.label, "yes", "the worker verdict stands");
  assert.equal(
    line.escalatedBy,
    "director-concurred",
    "a reviewed-and-confirmed verdict is structurally distinguishable from never-reviewed",
  );
  mock.handlers.delete("integ-agree");
});

// =============================================================================
// 8 — evidence-cell cap honesty
// =============================================================================

test("fix 8: evidence cells cap at 100 ids while results carry the TRUE n (distribution n; triangulation divergentN)", async () => {
  const slug = "cell-cap";
  const N = 150;
  const units = makeUnits(N, { isPay: () => true }); // every unit is "yes" for the judge
  const dictInst = createInstrument({
    id: "inst_d",
    constructId: "c_bin",
    kind: "dictionary",
    name: "dict",
    payload: {
      categories: [{ name: "never", terms: [{ term: "zzznevermatches" }] }],
      negation: { enabled: false, window: 3 },
      scoring: "count",
    },
  });
  const { project } = await setup(slug, { units, instruments: [judgeInstrument(), dictInst] });
  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);

  const jRun = await engineMod.createRun(project, { instrumentId: "inst_j", corpusId: "c1" });
  await engineMod.executeRun(slug, jRun.id);
  const dRun = await engineMod.createRun(project, { instrumentId: "inst_d", corpusId: "c1" });
  await engineMod.executeRun(slug, dRun.id);

  const post = routeHandler(analysesRoutes, "POST", "/api/projects/:p/analyses");
  const descriptive = await post(
    { body: { kind: "descriptive", spec: { runId: jRun.id } } },
    null,
    { p: slug },
  );
  assert.equal(descriptive.results.distribution.yes.n, N, "results carry the TRUE n");
  assert.equal(
    descriptive.evidence.cells.yes.length,
    100,
    "the evidence cell lists only the first 100 ids",
  );

  // judge says yes everywhere, the dictionary never matches → all divergent
  const tri = await post(
    {
      body: {
        kind: "triangulation",
        spec: { instrumentIds: ["inst_j", "inst_d"], corpusId: "c1" },
      },
    },
    null,
    { p: slug },
  );
  assert.equal(tri.results.divergentN, N, "triangulation reports the TRUE divergent count");
  assert.equal(
    tri.evidence.cells.divergent.length,
    100,
    "the divergent evidence cell caps at 100 ids",
  );
  assert.ok(tri.results.divergent.length <= 200);
});

// =============================================================================
// 10 — uncertainty-design gold guard
// =============================================================================

test("fix 10: uncertainty-design gold never mints level corrected — π is nominal, and the analysis says so", async () => {
  const slug = "uncertainty-gold";
  const units = makeUnits(30);
  const { project } = await setup(slug, { units, instruments: [judgeInstrument()] });
  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);

  const run = await engineMod.createRun(project, { instrumentId: "inst_j", corpusId: "c1" });
  await engineMod.executeRun(slug, run.id);
  await plantGoldset(slug, {
    id: "gs_unc",
    constructId: "c_bin",
    design: "uncertainty",
    units: units.slice(0, 10),
    labelOf: (u) => ORACLE(u.text),
    pi: 10 / 30, // nominal — uncertainty ranking is not a probability design
  });

  const analysis = await routeHandler(analysesRoutes, "POST", "/api/projects/:p/analyses")(
    { body: { kind: "descriptive", spec: { runId: run.id } } },
    null,
    { p: slug },
  );
  assert.notEqual(analysis.level, "corrected", "nominal π cannot license a Corrected claim");
  assert.equal(
    analysis.level,
    "exploratory",
    "the instrument's level carries over (capped below corrected)",
  );
  assert.equal(analysis.results.estimator, undefined, "no DSL estimator ran on nominal π");
  assert.equal(analysis.results.cells, undefined);
  assert.equal(
    analysis.results.note,
    "Gold drawn by uncertainty ranking: π is nominal, so design-based correction does not apply.",
  );
});

// =============================================================================
// 11 — continuous scale bounds in prompt + schema
// =============================================================================

test("fix 11: a continuous construct with scale {1,7} renders 'from 1 to 7' and enforces 1..7 in the response schema", () => {
  const scaled = createConstruct({
    id: "c_scale",
    name: "Enthusiasm",
    type: "continuous",
    definition: "How enthusiastic the unit is.",
    scale: { min: 1, max: 7 },
  });
  const schema = outputSchemaFor(scaled);
  assert.equal(schema.type, "score0to100");
  assert.equal(schema.min, 1);
  assert.equal(schema.max, 7);
  const json = jsonSchemaFor(schema);
  assert.equal(json.properties.label.minimum, 1);
  assert.equal(json.properties.label.maximum, 7);

  const messages = assemble(scaled, judgePayload(), { id: "u1", text: "I love this." });
  const system = messages.find((m) => m.role === "system").content;
  assert.match(system, /from 1 to 7/, "the coder instructions state the construct's actual bounds");
  assert.ok(
    !system.includes("from 0 to 100"),
    "no contradictory 0–100 instruction for a 1–7 scale",
  );

  // a stored pre-fix schema (no bounds) + a scaled construct: assembly still
  // renders the construct's declared bounds rather than the 0–100 default
  const legacy = assemble(scaled, judgePayload({ schema: { type: "score0to100" } }), {
    id: "u1",
    text: "I love this.",
  });
  assert.match(legacy.find((m) => m.role === "system").content, /from 1 to 7/);

  // no declared scale → the historical 0..100 contract is unchanged
  const unscaled = createConstruct({
    id: "c_plain",
    name: "Plain",
    type: "continuous",
    definition: "d",
  });
  const plain = outputSchemaFor(unscaled);
  assert.equal(jsonSchemaFor(plain).properties.label.minimum, 0);
  assert.equal(jsonSchemaFor(plain).properties.label.maximum, 100);
  const plainMsgs = assemble(unscaled, judgePayload(), { id: "u1", text: "t" });
  assert.match(plainMsgs.find((m) => m.role === "system").content, /from 0 to 100/);
});

// =============================================================================
// 12 — Director repair metering
// =============================================================================

test("fix 12: schema-repair attempts bill — the Director meter accumulates EVERY attempt's usage, not just the final response", async (t) => {
  // fixed per-call usage so attempts are countable through the meter
  const proto = Object.getPrototypeOf(mock);
  mock.complete = async function patched(req) {
    const res = await proto.complete.call(this, req);
    return { ...res, usage: { inputTokens: 100, outputTokens: 10 } };
  };
  t.after(() => {
    delete mock.complete;
  });

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["ok"],
    properties: { ok: { type: "string" } },
  };
  const director = (handler) => ({
    provider: "mock",
    model: "mock-1",
    snapshot: "mock-1",
    systemSuffix: `[[handler:${handler}]]`,
  });

  // clean single-attempt baseline
  mock.setHandler("integ-meter-clean", () => ({ ok: "yes" }));
  const projectA = {
    id: "p_meterclean00001",
    slug: "meter-clean",
    privacyMode: "open",
    director: director("integ-meter-clean"),
  };
  const resA = await callDirector(projectA, {
    messages: [{ role: "user", content: "go" }],
    schema,
  });
  assert.equal(resA.repairs, 0);
  const costsA = directorCosts(projectA);
  assert.equal(costsA.calls, 1);
  assert.equal(costsA.inputTokens, 100, "one attempt → one attempt's tokens");

  // first attempt fails the schema, the repair lands
  let attempts = 0;
  mock.setHandler("integ-meter-repair", () => {
    attempts += 1;
    return attempts === 1 ? { wrong: true } : { ok: "yes" };
  });
  const projectB = {
    id: "p_meterrepair0001",
    slug: "meter-repair",
    privacyMode: "open",
    director: director("integ-meter-repair"),
  };
  const resB = await callDirector(projectB, {
    messages: [{ role: "user", content: "go" }],
    schema,
  });
  assert.equal(resB.repairs, 1, "exactly one repair re-prompt");
  const costsB = directorCosts(projectB);
  assert.equal(costsB.calls, 1, "one logical Director call");
  assert.equal(
    costsB.inputTokens,
    200,
    "BOTH attempts' tokens reach the meter — repair re-prompts bill real money",
  );
  assert.equal(costsB.outputTokens, 20);
  mock.handlers.delete("integ-meter-clean");
  mock.handlers.delete("integ-meter-repair");
});
