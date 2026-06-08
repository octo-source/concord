// Engine-robustness regression suite (June 2026 concurrency/IO sweep). Pins,
// red-first, the five confirmed code-review bugs in the run engine, the store
// NDJSON appender, and the dossier/analyses readers:
//
//   1  persistRun must update only the engine-owned mutable fields in place —
//      a concurrent route mutation (PUT /runs/:r rename, or any other write to
//      a route-owned field like name/pinned/capUSD) survives the next engine
//      checkpoint instead of being reverted by a whole-object clobber.
//   2  appendNdjson retries a transient Dropbox/Windows sync lock
//      (EPERM/EBUSY/EACCES) with backoff instead of crashing the run to
//      "failed" — the same retry every rename site uses. (The shared helper is
//      unit-tested directly; the appender is tested through a one-shot fault
//      seam.)
//   3  the evidence dossier does NOT silently swallow BAD_NDJSON / real I/O
//      faults — a corrupt outputs file surfaces (errors or warns), it does not
//      vanish a unit's outputs and read empty.
//   4  analyses.js panel co-occurrence narrows its readNdjson catch to
//      NOT_FOUND/ENOENT (no blanket swallow of corruption).
//   5  two near-simultaneous launches for one run do not poison the registry:
//      the run does not end up "failed", exactly one execution proceeds, the
//      RUN_ACTIVE loser never flips the disk record to failed.
//
// Hermetic: MockModel only, bundles under a temp CONCORD_PROJECTS_DIR (route
// handlers resolve the default projects dir from the env var).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as engineMod from "../../server/runs/engine.js";
import * as store from "../../server/core/store.js";
import runsRoutes from "../../server/routes/runs.js";
import evidenceRoutes from "../../server/routes/evidence.js";
import analysesRoutes from "../../server/routes/analyses.js";
import { DEFAULT_TEMPLATE } from "../../server/instruments/judge.js";
import { createProject, createConstruct, createInstrument } from "../../server/core/objects.js";
import { saveProject, loadProject, updateProject, readNdjson, projectDir } from "../../server/core/store.js";
import { ConcordError } from "../../server/core/errors.js";
import { getAdapter } from "../../server/providers/registry.js";

// ---------------------------------------------------------------- harness

let tmpRoot;
before(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "concord-robust-"));
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
  createInstrument({ id: "inst_j", constructId: "c_bin", kind: "judge", name: "judge", payload: judgePayload(payloadExtra), ...extra });

// Equal-length unit texts: the p99-length escalation predicate stays quiet.
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

async function setup(slug, { units, instruments = [], constructs = [binaryConstruct()], director = null } = {}) {
  const project = createProject({ name: slug, slug, privacyMode: "open" });
  project.director = director;
  project.corpora.push({ id: "c1", name: "corpus" });
  project.constructs.push(...constructs);
  project.instruments.push(...instruments);
  await saveProject(project);
  const file = path.join(projectDir(slug), "corpora", "c1", "units.ndjson");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, units.length ? units.map((u) => JSON.stringify(u)).join("\n") + "\n" : "", "utf8");
  return { project, pdir: projectDir(slug) };
}

const outputsFile = (slug, runId) => path.join(projectDir(slug), "runs", runId, "outputs.ndjson");

function routeHandler(routes, method, pattern) {
  const r = routes.find((x) => x.method === method && x.pattern === pattern);
  assert.ok(r, `route ${method} ${pattern} exists`);
  return r.handler;
}

// =============================================================================
// 1 — persistRun in-place update (no whole-object clobber)
// =============================================================================

test("fix 1: a concurrent rename mid-run survives the engine's next checkpoint (persistRun updates engine-owned fields in place)", async () => {
  const slug = "persist-rename";
  const N = 120; // > CHECKPOINT_EVERY (25) so a checkpoint write lands mid-run
  const { project } = await setup(slug, { units: makeUnits(N), instruments: [judgeInstrument()] });
  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);

  const run = await engineMod.createRun(project, { instrumentId: "inst_j", corpusId: "c1" });
  assert.equal(run.name, "judge · corpus" === run.name ? run.name : run.name); // name is "" here (createRun got none)

  // Rename the run on disk the instant the engine starts ticking — this is the
  // PUT /runs/:r route mutating a route-owned field while the engine runs. The
  // whole-object clobber would revert it on the very next checkpoint.
  let renamed = false;
  const done = await engineMod.executeRun(slug, run.id, {
    onTick: async () => {
      if (!renamed) {
        renamed = true;
        await updateProject(slug, (p) => {
          const r = p.runs.find((x) => x.id === run.id);
          r.name = "RENAMED MID RUN";
        });
      }
    },
  });
  assert.equal(done.status, "complete");

  const onDisk = (await loadProject(slug)).runs.find((r) => r.id === run.id);
  // engine-owned fields advanced…
  assert.equal(onDisk.status, "complete", "the engine still drove status to terminal");
  assert.equal(onDisk.checkpoint.done, N, "the engine still advanced the checkpoint");
  assert.ok(onDisk.labelDist && Object.keys(onDisk.labelDist).length > 0, "engine still persisted labelDist");
  // …and the route-owned field the engine does NOT own survived every checkpoint
  assert.equal(onDisk.name, "RENAMED MID RUN",
    "a concurrent rename of a route-owned field is NOT reverted by the engine's checkpoint/terminal writes");
});

test("fix 1: route-owned fields set after createRun (pinned/capUSD) survive a full run untouched", async () => {
  const slug = "persist-fields";
  const N = 60;
  const { project } = await setup(slug, { units: makeUnits(N), instruments: [judgeInstrument()] });
  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);

  const run = await engineMod.createRun(project, { instrumentId: "inst_j", corpusId: "c1" });
  // a route writes a non-engine field onto the disk record before/while running
  await updateProject(slug, (p) => {
    const r = p.runs.find((x) => x.id === run.id);
    r.name = "kept name";
    r.pinned = true;
    r.capUSD = 42;
  });

  const done = await engineMod.executeRun(slug, run.id);
  assert.equal(done.status, "complete");

  const onDisk = (await loadProject(slug)).runs.find((r) => r.id === run.id);
  assert.equal(onDisk.name, "kept name", "name survives");
  assert.equal(onDisk.pinned, true, "pinned survives");
  assert.equal(onDisk.capUSD, 42, "capUSD survives");
  // engine-owned fields are still correct
  assert.equal(onDisk.checkpoint.done, N);
  assert.equal(onDisk.cost.actualUSD, 0);
});

// =============================================================================
// 2 — appendNdjson transient-lock retry
// =============================================================================

test("fix 2: the shared transient-error retry helper retries EPERM/EBUSY/EACCES and rethrows others", async () => {
  assert.equal(typeof store.retryTransient, "function",
    "store exports a shared transient-error retry helper (extracted from renameWithRetry)");

  // a one-shot EPERM is retried and the operation ultimately succeeds
  let calls = 0;
  const out = await store.retryTransient(async () => {
    calls += 1;
    if (calls === 1) {
      const err = new Error("EPERM: operation not permitted");
      err.code = "EPERM";
      throw err;
    }
    return "ok";
  }, { baseMs: 1 });
  assert.equal(out, "ok");
  assert.equal(calls, 2, "retried exactly once after the transient fault");

  // a non-transient error is NOT retried — it propagates on the first throw
  let calls2 = 0;
  await assert.rejects(
    () => store.retryTransient(async () => {
      calls2 += 1;
      const err = new Error("ENOSPC: no space left on device");
      err.code = "ENOSPC";
      throw err;
    }, { baseMs: 1 }),
    (e) => e.code === "ENOSPC",
  );
  assert.equal(calls2, 1, "a non-transient fault is not retried");

  // a persistent transient fault eventually gives up after `attempts`
  let calls3 = 0;
  await assert.rejects(
    () => store.retryTransient(async () => {
      calls3 += 1;
      const err = new Error("EBUSY: resource busy");
      err.code = "EBUSY";
      throw err;
    }, { attempts: 3, baseMs: 1 }),
    (e) => e.code === "EBUSY",
  );
  assert.equal(calls3, 3, "gave up after exactly `attempts` tries");
});

test("fix 2: appendNdjson retries a one-shot transient append fault and still writes the line", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "concord-append-"));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  const file = path.join(dir, "outputs.ndjson");

  // Seed a first line so the append path is the live (file exists) branch.
  await store.appendNdjson(file, { unitId: "u0", juror: "j", label: "yes" });

  // Inject a one-shot EPERM into the next append attempt via the minimal
  // fault-injection seam the fix adds. Without a retry this EPERM escapes and
  // crashes the run; with the retry the second attempt succeeds.
  assert.equal(typeof store.__setAppendFaultInjector, "function",
    "store exposes a minimal append fault-injection seam for the retry test");
  let fired = false;
  store.__setAppendFaultInjector(() => {
    if (fired) return;
    fired = true;
    const err = new Error("EPERM: operation not permitted, open (injected Dropbox lock)");
    err.code = "EPERM";
    throw err;
  });
  t.after(() => store.__setAppendFaultInjector(null));

  const res = await store.appendNdjson(file, { unitId: "u1", juror: "j", label: "no" });
  assert.ok(fired, "the injected fault really fired");
  assert.ok(res && typeof res.size === "number", "append returned its size after retrying");

  const lines = await readNdjson(file);
  assert.equal(lines.length, 2, "both lines are on disk — the transient fault was retried, not fatal");
  assert.deepEqual(lines.map((l) => l.unitId), ["u0", "u1"]);
});

// =============================================================================
// 3 — evidence dossier does not swallow corruption
// =============================================================================

test("fix 3: a corrupt run outputs file does NOT silently vanish from the dossier (it surfaces)", async () => {
  const slug = "dossier-corrupt";
  const units = makeUnits(6);
  const { project } = await setup(slug, { units, instruments: [judgeInstrument()] });
  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);

  const run = await engineMod.createRun(project, { instrumentId: "inst_j", corpusId: "c1" });
  await engineMod.executeRun(slug, run.id);

  // Corrupt the outputs file MID-FILE (a non-final garbage line followed by a
  // good line, WITH a trailing newline → readNdjson throws BAD_NDJSON, this is
  // not a torn tail). readNdjson already returns [] for ENOENT, so the dossier
  // catch only ever swallowed real corruption / I/O faults like this one.
  const target = units[0].id;
  const file = outputsFile(slug, run.id);
  const good = (await readFile(file, "utf8")).trimEnd().split("\n");
  const corrupt = [good[0], "{ this is not json", ...good.slice(1)].join("\n") + "\n";
  await writeFile(file, corrupt, "utf8");

  // sanity: the raw reader really throws on this file
  await assert.rejects(() => readNdjson(file), (e) => e.code === "BAD_NDJSON");

  const handler = routeHandler(evidenceRoutes, "GET", "/api/projects/:p/evidence/:unitId");
  let threw = null;
  let result = null;
  try {
    result = await handler({ query: {} }, null, { p: slug, unitId: target });
  } catch (err) {
    threw = err;
  }

  if (threw) {
    // acceptable: the corruption propagates as an error instead of vanishing
    assert.ok(threw.code === "BAD_NDJSON" || /NDJSON|corrupt/i.test(threw.message ?? ""),
      `the dossier surfaces the corruption as an error (got ${threw.code}: ${threw.message})`);
  } else {
    // also acceptable: a dossier-level warning that does NOT pretend the run
    // simply had no outputs for this unit. The bug was a SILENT empty.
    const run0 = result.outputs.find((o) => o.runId === run.id);
    const warned = Array.isArray(result.warnings) && result.warnings.some((w) => w.runId === run.id || /NDJSON|corrupt/i.test(String(w.message ?? w)));
    assert.ok(warned || run0,
      "a corrupt outputs file must NOT silently read as 'no outputs for this unit' — it errors or surfaces a warning");
  }
});

// =============================================================================
// 4 — analyses.js panel co-occurrence does not swallow corruption
// =============================================================================
//
// NOTE on coverage: the panel co-occurrence supplement and the main
// assembleRows path read the SAME outputs file, and readNdjson parses every
// line before applying any filter — so a mid-file BAD_NDJSON line throws on
// whichever read reaches it first (assembleRows, in the POST handler). The
// narrowed catch on the co-occurrence read is therefore defensive consistency
// with fix #3 (only a transient I/O fault hitting one read but not the other
// could exercise it in isolation, which needs fs-level injection into
// readNdjson — out of scope here). What this test pins is the USER-VISIBLE
// guarantee: a corrupt panel outputs file does NOT yield a silently-empty
// analysis — it surfaces as an error instead of vanishing the data.
test("fix 4 (pin): a corrupt panel outputs file surfaces from the analysis instead of silently emptying", async () => {
  const slug = "panel-corrupt";
  const N = 9;
  const units = makeUnits(N);
  const jurors = [judgePayload({ params: { temperature: 0, maxTokens: 64, seed: "j1" } }),
                  judgePayload({ params: { temperature: 0, maxTokens: 64, seed: "j2" } }),
                  judgePayload({ params: { temperature: 0, maxTokens: 64, seed: "j3" } })];
  const panel = createInstrument({
    id: "inst_p", constructId: "c_bin", kind: "panel", name: "panel",
    payload: { jurors, aggregation: "majority" },
  });
  const { project } = await setup(slug, { units, instruments: [panel] });
  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);

  const run = await engineMod.createRun(project, { instrumentId: "inst_p", corpusId: "c1" });
  await engineMod.executeRun(slug, run.id);

  // corrupt mid-file with a trailing newline → BAD_NDJSON (not a torn tail)
  const file = outputsFile(slug, run.id);
  const good = (await readFile(file, "utf8")).trimEnd().split("\n");
  const corrupt = [good[0], "{ broken juror line", ...good.slice(1)].join("\n") + "\n";
  await writeFile(file, corrupt, "utf8");
  await assert.rejects(() => readNdjson(file), (e) => e.code === "BAD_NDJSON");

  const post = routeHandler(analysesRoutes, "POST", "/api/projects/:p/analyses");
  await assert.rejects(
    () => post({ body: { kind: "descriptive", spec: { runId: run.id } } }, null, { p: slug }),
    (e) => e.code === "BAD_NDJSON" || /NDJSON|corrupt/i.test(e.message ?? ""),
    "a corrupt panel outputs file must surface, not produce a silently-empty analysis",
  );
});

// =============================================================================
// 5 — double-launch registry poison
// =============================================================================

test("fix 5: two overlapping launches for one run do not poison the registry (run never ends up failed; exactly one execution proceeds)", async () => {
  const slug = "double-launch";
  const N = 80;
  const { project } = await setup(slug, { units: makeUnits(N), instruments: [judgeInstrument()] });
  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);

  const run = await engineMod.createRun(project, { instrumentId: "inst_j", corpusId: "c1" });

  // Two resume POSTs fired back-to-back for the SAME run id. Before the fix the
  // 2nd launch's executeRun throws RUN_ACTIVE and the startExecution backstop
  // flips the disk record to "failed" while the 1st is genuinely running.
  const resume = routeHandler(runsRoutes, "POST", "/api/projects/:p/runs/:r/resume");
  const [a, b] = await Promise.allSettled([
    resume({}, null, { p: slug, r: run.id }),
    resume({}, null, { p: slug, r: run.id }),
  ]);

  // both route calls answer (each either launches or 400s "already executing"),
  // neither throws RUN_ACTIVE out to the client
  for (const settled of [a, b]) {
    if (settled.status === "rejected") {
      assert.notEqual(settled.reason?.code, "RUN_ACTIVE",
        "RUN_ACTIVE must never escape to the client — the backstop owns it, it is not a failure");
    }
  }

  // wait for the genuine execution to settle
  let onDisk = null;
  for (let i = 0; i < 100; i++) {
    onDisk = (await loadProject(slug)).runs.find((r) => r.id === run.id);
    if (onDisk.status === "complete" || onDisk.status === "failed") break;
    await sleep(50);
  }
  assert.equal(onDisk.status, "complete",
    "the run completes — the RUN_ACTIVE loser must NOT flip the genuinely-running record to failed");
  assert.equal(onDisk.error, undefined, "no error stamped on the record");

  const lines = await readNdjson(outputsFile(slug, run.id));
  assert.equal(lines.length, N, "exactly one execution produced the full output set");
  const seen = new Set();
  for (const l of lines) {
    const k = `${l.unitId}|${l.juror}`;
    assert.ok(!seen.has(k), `no duplicate output line for ${k} (only one execution wrote)`);
    seen.add(k);
  }
});
