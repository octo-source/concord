// Engine-hardening regression suite (June 2026 deep empirical review). Pins,
// red-first, nine confirmed engine/store/object bugs that survived the first
// concurrency sweep (engine-robustness.test.js covers the earlier five):
//
//   1  forEachUnit stops EVERY worker when one fn throws — no paid provider
//      calls dispatched after the first throw, the error propagates with its
//      code, surviving workers drain (no detached workers racing a resume).
//   2  a provider fault inside the drift re-judge (monitor.driftTick) is caught
//      by the engine: a PAUSE-class fault pauses the run resumably; any other
//      fault warns and the run CONTINUES (a broken drift check never fails it).
//   3  a unit that SUCCEEDS on resume is removed from run.quarantine — it can't
//      end with both a verdict line and a quarantine entry.
//   4  appendNdjson serializes heal+append per file path — concurrent appends
//      to a torn-tail file never truncate a co-writer's just-written line.
//   5  pricingFor warns once when a PRICED provider's catalog fetch fails (the
//      run surfaces "cost tracking unavailable" instead of a silent $0); a
//      genuinely-free local provider still prices $0 without warning.
//   6  run.escalation.count is re-derived from the persisted escalated finals
//      on resume (a crash that lost live increments self-heals).
//   7  monitor warnings are ring-buffer capped — a mass failure cannot grow the
//      array (or its per-poll copy) without bound; the latest are retained.
//   8  createProject rejects an EXPLICIT reserved Windows device-name slug
//      ("con"/"aux"/…) with VALIDATION (the regex used to pass it through).
//   9  createProjectIfAbsent is atomic: two concurrent creates of one slug →
//      exactly one wins, the other gets a clean VALIDATION.
//
// Hermetic: MockModel only, bundles under a temp CONCORD_PROJECTS_DIR (route
// handlers resolve the default projects dir from the env var).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as engineMod from "../../server/runs/engine.js";
import * as monitor from "../../server/runs/monitor.js";
import * as store from "../../server/core/store.js";
import projectsRoutes from "../../server/routes/projects.js";
import { DEFAULT_TEMPLATE } from "../../server/instruments/judge.js";
import { createProject, createConstruct, createInstrument } from "../../server/core/objects.js";
import {
  saveProject,
  loadProject,
  updateProject,
  readNdjson,
  projectDir,
} from "../../server/core/store.js";
import { ConcordError } from "../../server/core/errors.js";
import { getAdapter } from "../../server/providers/registry.js";

// ---------------------------------------------------------------- harness

let tmpRoot;
before(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "concord-harden-"));
  process.env.CONCORD_PROJECTS_DIR = tmpRoot;
});
after(async () => {
  delete process.env.CONCORD_PROJECTS_DIR;
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

const mock = getAdapter({ privacyMode: "open" }, "mock").adapter;
const ORACLE = (text) => (text.includes("pay salary") ? "yes" : "no");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reset the shared memoized mock to a clean state between tests (oracle,
// accuracy, handlers, and any complete/catalog/capabilities monkeypatches).
function resetMock() {
  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);
  mock.handlers.clear();
  delete mock.complete;
  delete mock.catalog;
  delete mock.capabilities;
}

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

async function setup(
  slug,
  { units, instruments = [], constructs = [binaryConstruct()], director = null } = {},
) {
  const project = createProject({ name: slug, slug, privacyMode: "open" });
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

function routeHandler(routes, method, pattern) {
  const r = routes.find((x) => x.method === method && x.pattern === pattern);
  assert.ok(r, `route ${method} ${pattern} exists`);
  return r.handler;
}

// =============================================================================
// 1 — forEachUnit stops the whole pool on a throw (no runaway paid calls)
// =============================================================================

test("fix 1: a worker fn throwing stops every worker — no units dispatched after the throw, the error propagates with its code", async (t) => {
  resetMock();
  t.after(resetMock);
  const slug = "stop-on-throw";
  const M = 60;
  const C = 4;
  const units = makeUnits(M);
  const { project } = await setup(slug, { units, instruments: [judgeInstrument()] });

  // Count provider calls; throw a propagating, NON-Pool-retryable fault on the
  // Nth call (RATE_LIMITED_EXHAUSTED is the terminal pause-class code — the Pool
  // does not retry it, so it escapes on the first occurrence). runEphemeral's
  // worker fn calls processUnit directly and lets the throw propagate, so this
  // exercises forEachUnit's stop-on-throw directly.
  const N = 12;
  let calls = 0;
  const proto = Object.getPrototypeOf(mock);
  mock.complete = async function patched(req) {
    const mine = ++calls;
    if (mine === N) throw new ConcordError("RATE_LIMITED_EXHAUSTED", "gave up after retries", {});
    return proto.complete.call(this, req);
  };
  t.after(() => {
    delete mock.complete;
  });

  await assert.rejects(
    () => engineMod.runEphemeral(project, judgeInstrument(), units, { concurrency: C }),
    (err) => {
      assert.equal(
        err.code,
        "RATE_LIMITED_EXHAUSTED",
        "the original taxonomy code propagates (callers branch on it)",
      );
      return true;
    },
  );

  // The pool must stop dispatching after the first throw: at most (C-1) calls
  // were already in flight past the dispatch check. A pre-fix forEachUnit kept
  // the surviving workers pulling all M units (calls would approach M).
  assert.ok(
    calls <= N + (C - 1),
    `provider calls bounded after the throw: ${calls} ≤ ${N + (C - 1)} (M=${M} would mean no stop)`,
  );
  assert.ok(calls < M, `definitely fewer than the full corpus (${calls} < ${M})`);

  // Settle window: no further calls land after rejection resolves (no detached
  // workers still running — those would race a resume into duplicate lines).
  const settledAt = calls;
  await sleep(120);
  assert.equal(
    calls,
    settledAt,
    "no provider calls after the rejection settled — every worker drained",
  );
});

test("fix 1: concurrency 1 → the throw stops dispatch at exactly the failing unit (tight bound)", async (t) => {
  resetMock();
  t.after(resetMock);
  const slug = "stop-on-throw-c1";
  const M = 40;
  const units = makeUnits(M);
  const { project } = await setup(slug, { units, instruments: [judgeInstrument()] });

  const N = 7;
  let calls = 0;
  const proto = Object.getPrototypeOf(mock);
  mock.complete = async function patched(req) {
    const mine = ++calls;
    if (mine === N) throw new ConcordError("RATE_LIMITED_EXHAUSTED", "gave up", {});
    return proto.complete.call(this, req);
  };
  t.after(() => {
    delete mock.complete;
  });

  await assert.rejects(
    () => engineMod.runEphemeral(project, judgeInstrument(), units, { concurrency: 1 }),
    (err) => err.code === "RATE_LIMITED_EXHAUSTED",
  );
  // serial: exactly N calls, the Nth threw — nothing after it dispatched
  assert.equal(calls, N, "serial dispatch halts at the failing unit, no further units");
});

// =============================================================================
// 2 — a drift re-judge fault never cascades through the worker pool
// =============================================================================

test("fix 2: a PAUSE-class fault inside the drift re-judge pauses the run resumably (not failed, not a pool rejection)", async (t) => {
  resetMock();
  t.after(resetMock);
  const slug = "drift-pause";
  const N = 30;
  const units = makeUnits(N);
  const inst = judgeInstrument();
  const { project } = await setup(slug, { units, instruments: [inst] });

  // The drift re-judge calls the provider with a seed prefixed "drift:". Throw
  // PROVIDER_UNREACHABLE ONLY for those calls; the run's own worker calls
  // (no/seed-less) succeed normally.
  const proto = Object.getPrototypeOf(mock);
  mock.complete = async function patched(req) {
    if (typeof req.seed === "string" && req.seed.startsWith("drift:")) {
      throw new ConcordError("PROVIDER_UNREACHABLE", "drift re-judge: network down", {
        kind: "TypeError",
      });
    }
    return proto.complete.call(this, req);
  };
  t.after(() => {
    delete mock.complete;
  });

  const goldOutputs = makeUnits(4).map((u) => ({ unit: u, label: ORACLE(u.text) }));
  const run = await engineMod.createRun(project, { instrumentId: "inst_j", corpusId: "c1" });
  // small `every` so the drift tick fires early in the run; the armed dir is the
  // projects root (the engine resolves the same root from CONCORD_PROJECTS_DIR).
  // Explicit baseline (the instrument is unfrozen, no certificate).
  monitor.armDriftTripwire(run.id, {
    project,
    goldOutputs,
    instrument: inst,
    every: 5,
    threshold: 0.15,
    baseline: 1.0,
    dir: tmpRoot,
  });

  const paused = await engineMod.executeRun(slug, run.id, { concurrency: 1 });
  assert.equal(
    paused.status,
    "paused",
    "a PAUSE-class drift fault pauses the run, it does NOT fail or reject the pool",
  );
  assert.equal(paused.error?.code, "PROVIDER_UNREACHABLE");
  const onDisk = (await loadProject(slug)).runs[0];
  assert.equal(onDisk.status, "paused", "the resumable status is persisted");

  // resume with drift healthy → completes exactly-once
  delete mock.complete;
  monitor.clearRun(run.id);
  const done = await engineMod.executeRun(slug, run.id, { concurrency: 1 });
  assert.equal(done.status, "complete");
  const lines = await readNdjson(outputsFile(slug, run.id));
  const seen = new Set();
  for (const l of lines) {
    const k = `${l.unitId}|${l.juror}`;
    assert.ok(!seen.has(k), `no duplicate line for ${k}`);
    seen.add(k);
  }
  assert.equal(lines.length, N, "exactly-once outputs across the drift pause + resume");
});

test("fix 2: a NON-pause fault inside the drift re-judge warns and the run CONTINUES to completion", async (t) => {
  resetMock();
  t.after(resetMock);
  const slug = "drift-continue";
  const N = 30;
  const units = makeUnits(N);
  const inst = judgeInstrument();
  const { project } = await setup(slug, { units, instruments: [inst] });

  // Drift re-judge calls throw a generic (non-pause, non-quarantine) fault.
  const proto = Object.getPrototypeOf(mock);
  mock.complete = async function patched(req) {
    if (typeof req.seed === "string" && req.seed.startsWith("drift:")) {
      throw new ConcordError("BOOM_DRIFT", "drift re-judge exploded", {});
    }
    return proto.complete.call(this, req);
  };
  t.after(() => {
    delete mock.complete;
  });

  const goldOutputs = makeUnits(4).map((u) => ({ unit: u, label: ORACLE(u.text) }));
  const run = await engineMod.createRun(project, { instrumentId: "inst_j", corpusId: "c1" });
  monitor.armDriftTripwire(run.id, {
    project,
    goldOutputs,
    instrument: inst,
    every: 5,
    threshold: 0.15,
    baseline: 1.0,
    dir: tmpRoot,
  });

  let lastTick = null;
  const done = await engineMod.executeRun(slug, run.id, {
    concurrency: 1,
    onTick: (s) => {
      lastTick = s;
    },
  });
  assert.equal(done.status, "complete", "a broken drift check must never fail the run");
  const lines = await readNdjson(outputsFile(slug, run.id));
  assert.equal(lines.length, N, "every unit still produced its verdict");
  assert.ok(
    lastTick.warnings.some((w) => w.kind === "drift-failed"),
    "the drift failure is surfaced as a warning, not swallowed",
  );
});

// =============================================================================
// 3 — quarantine cleared when a unit succeeds on resume
// =============================================================================

test("fix 3: a unit quarantined in session 1 that SUCCEEDS on resume is removed from run.quarantine (and has a verdict line)", async (t) => {
  resetMock();
  t.after(resetMock);
  const slug = "quar-cleared";
  const N = 8;
  const units = makeUnits(N);
  const target = units[3];

  // Session 1: the target unit is schema-invalid on EVERY attempt → quarantine;
  // the run pauses afterwards (via a transient on a later unit) leaving the
  // quarantine entry on the record with the target NOT yet verdicted.
  const inst = judgeInstrument({}, { promptTemplate: `[[handler:q3]]\n${DEFAULT_TEMPLATE}` });
  const { project } = await setup(slug, { units, instruments: [inst] });

  let poisonTarget = true; // session 1 poisons the target; session 2 lets it pass
  mock.setHandler("q3", (req) => {
    const all = req.messages.map((m) => m.content).join("\n");
    const unitText = all.match(/<unit>\n([\s\S]*?)\n<\/unit>/)?.[1] ?? "";
    if (unitText === target.text && poisonTarget) return { garbage: true }; // schema-invalid every attempt
    return { rationale: "scripted", label: ORACLE(unitText), confidence: 0.9 };
  });
  t.after(() => mock.handlers.delete("q3"));

  const run = await engineMod.createRun(project, { instrumentId: "inst_j", corpusId: "c1" });
  // run to completion in session 1: the target quarantines, everything else verdicts
  const s1 = await engineMod.executeRun(slug, run.id, { concurrency: 1 });
  assert.equal(s1.status, "complete");
  assert.equal(s1.quarantine.length, 1);
  assert.equal(s1.quarantine[0].unitId, target.id);
  assert.equal(s1.quarantine[0].code, "SCHEMA_INVALID");

  // Force a resumable re-run of the quarantined unit: mark the run paused and
  // clear the target's (absent) final line situation — the target has no final
  // line, so it is pending on resume. Session 2 lets it pass.
  await updateProject(
    slug,
    (p) => {
      p.runs[0].status = "paused";
    },
    undefined,
  );
  poisonTarget = false;

  const s2 = await engineMod.executeRun(slug, run.id, { concurrency: 1 });
  assert.equal(s2.status, "complete");
  // THE FIX: the previously-quarantined unit succeeded → it is no longer in the
  // quarantine set, and it now has a verdict line.
  assert.deepEqual(
    s2.quarantine,
    [],
    "the unit that succeeded on resume is cleared from quarantine",
  );
  const onDisk = (await loadProject(slug)).runs[0];
  assert.deepEqual(onDisk.quarantine, [], "the cleared quarantine persists");
  const lines = await readNdjson(outputsFile(slug, run.id));
  const targetLine = lines.find((l) => l.unitId === target.id);
  assert.ok(targetLine, "the formerly-quarantined unit now has a verdict line in outputs");
  assert.equal(targetLine.label, ORACLE(target.text));
  // run.completed must NOT ledger a phantom quarantined count
  assert.ok(
    !lines.some(
      (l, i) => lines.findIndex((x) => x.unitId === l.unitId && x.juror === l.juror) !== i,
    ),
    "outputs are exactly-once",
  );
});

// =============================================================================
// 4 — appendNdjson serializes heal+append (no co-writer truncation)
// =============================================================================

test("fix 4: appendNdjson serializes heal+append per file — concurrent appends to one torn-tail file never overlap their critical section (and all survive)", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "concord-append-race-"));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  t.after(() => store.__setAppendFaultInjector(null));
  const file = path.join(dir, "outputs.ndjson");

  // The truncation race (writer B's heal truncating to a stale size chops
  // writer A's just-appended line) is timing-dependent on a fast local fs, so a
  // plain count assertion can pass even unserialized. Pin the GUARANTEE instead
  // — that heal+append is serialized per file — via the awaitable fault seam.
  //
  // The injector is awaited at BOTH seams of every invocation (heal-open and
  // append) and yields a few ms each time. `occupancy` counts how many seam
  // sleeps are in flight AT ONCE. With the per-file lock only ONE invocation is
  // ever inside its heal→append body, so at most one seam sleep runs at a time
  // → occupancy never exceeds 1. WITHOUT the lock, all K writers enter their
  // bodies together and many seam sleeps overlap → occupancy ≫ 1. (No
  // entry/exit pairing needed: raw concurrency of the seam is unambiguous.)
  let occupancy = 0;
  let maxOccupancy = 0;
  store.__setAppendFaultInjector(async () => {
    occupancy += 1;
    maxOccupancy = Math.max(maxOccupancy, occupancy);
    await sleep(4);
    occupancy -= 1;
  });

  for (let round = 0; round < 3; round++) {
    // Seed a TORN tail: one complete line + a partial line with NO trailing
    // newline. The heal must truncate exactly the partial line.
    await writeFile(
      file,
      JSON.stringify({ unitId: "seed", juror: "j", label: "yes" }) +
        "\n{ partial torn line no newline",
      "utf8",
    );

    const K = 30;
    await Promise.all(
      Array.from({ length: K }, (_, i) =>
        store.appendNdjson(file, {
          unitId: `u_${round}_${String(i).padStart(3, "0")}`,
          juror: "j",
          label: i % 2 ? "yes" : "no",
        }),
      ),
    );

    const lines = await readNdjson(file);
    // all K concurrent appends survive, the torn partial is healed away, the
    // seed line is intact, and ids are unique (no garble/interleave)
    const appended = lines.filter((l) => l.unitId.startsWith(`u_${round}_`));
    assert.equal(
      appended.length,
      K,
      `round ${round}: all ${K} concurrent lines survive (got ${appended.length})`,
    );
    assert.ok(
      lines.some((l) => l.unitId === "seed"),
      `round ${round}: the seed line was not eaten`,
    );
    assert.equal(
      new Set(appended.map((l) => l.unitId)).size,
      K,
      `round ${round}: no duplicated/garbled append`,
    );

    await rm(file, { force: true });
  }

  // THE serialization guarantee: a given file's heal+append sections never
  // overlap. (Without the per-file lock, all K writers run concurrently and
  // their seam sleeps pile up far past 1.)
  assert.equal(
    maxOccupancy,
    1,
    `heal+append is serialized per file — at most one critical section in flight at a time (saw up to ${maxOccupancy} of K=30 concurrent)`,
  );
});

// =============================================================================
// 5 — pricingFor warns on a priced-provider catalog failure (no silent $0)
// =============================================================================

test("fix 5: a catalog failure for a PRICED provider surfaces a 'cost tracking unavailable' warning (metering still proceeds)", async (t) => {
  resetMock();
  t.after(resetMock);
  const slug = "pricing-warn";
  const N = 6;
  const { project } = await setup(slug, { units: makeUnits(N), instruments: [judgeInstrument()] });

  // Make the mock look like a PRICED (non-local) provider whose catalog fetch
  // fails — exactly the real-fetch-failure case pricingFor must flag.
  mock.capabilities = () => ({
    structuredOutput: true,
    pinning: true,
    batch: false,
    local: false,
    family: "mock",
  });
  mock.catalog = async () => {
    throw new ConcordError("PROVIDER_UNREACHABLE", "catalog fetch failed", {});
  };
  t.after(() => {
    delete mock.capabilities;
    delete mock.catalog;
  });

  const run = await engineMod.createRun(project, { instrumentId: "inst_j", corpusId: "c1" });
  let lastTick = null;
  const done = await engineMod.executeRun(slug, run.id, {
    onTick: (s) => {
      lastTick = s;
    },
  });

  assert.equal(
    done.status,
    "complete",
    "metering falls back to $0 but the run still completes (no crash)",
  );
  assert.equal(done.cost.actualUSD, 0, "the $0 fallback is preserved");
  assert.ok(
    lastTick.warnings.some(
      (w) => w.kind === "pricing-unavailable" && /cost tracking unavailable/i.test(w.message),
    ),
    "the run surfaces 'cost tracking unavailable' instead of a silent, misleading $0",
  );
});

test("fix 5: a genuinely-free LOCAL provider ($0 catalog) prices $0 WITHOUT a spurious warning", async (t) => {
  resetMock();
  t.after(resetMock);
  const slug = "pricing-local-ok";
  const N = 6;
  const { project } = await setup(slug, { units: makeUnits(N), instruments: [judgeInstrument()] });
  // default mock: local: true, catalog returns $0 pricing (no failure)

  const run = await engineMod.createRun(project, { instrumentId: "inst_j", corpusId: "c1" });
  let lastTick = null;
  const done = await engineMod.executeRun(slug, run.id, {
    onTick: (s) => {
      lastTick = s;
    },
  });
  assert.equal(done.status, "complete");
  assert.equal(done.cost.actualUSD, 0);
  assert.ok(
    !lastTick.warnings.some((w) => w.kind === "pricing-unavailable"),
    "a real free local provider must NOT raise a cost-tracking warning",
  );
});

// =============================================================================
// 6 — escalation.count re-derived from persisted finals on resume
// =============================================================================

test("fix 6: resume re-derives escalation.count from the persisted escalated finals (a lost live increment self-heals)", async (t) => {
  resetMock();
  t.after(resetMock);
  const slug = "esc-recount";
  const N = 24;
  const units = makeUnits(N);
  // Deterministically escalate exactly three units via low confidence (< 0.6
  // fires the escalation predicate); the rest are confidently correct.
  const escalatedIds = new Set(["u_0003", "u_0009", "u_0015"]);
  const inst = judgeInstrument({}, { promptTemplate: `[[handler:esc6]]\n${DEFAULT_TEMPLATE}` });
  const { project } = await setup(slug, { units, instruments: [inst] });
  mock.setHandler("esc6", (req) => {
    const all = req.messages.map((m) => m.content).join("\n");
    const unitText = all.match(/<unit>\n([\s\S]*?)\n<\/unit>/)?.[1] ?? "";
    const unit = units.find((u) => u.text === unitText);
    const label = ORACLE(unitText);
    return {
      rationale: "scripted",
      label,
      confidence: unit && escalatedIds.has(unit.id) ? 0.3 : 0.95,
    };
  });
  t.after(() => mock.handlers.delete("esc6"));

  const run = await engineMod.createRun(project, { instrumentId: "inst_j", corpusId: "c1" });
  // run to completion (no Director → low-confidence units are flagged escalated:true)
  const done = await engineMod.executeRun(slug, run.id, { concurrency: 1 });
  assert.equal(done.status, "complete");
  assert.equal(done.escalation.count, escalatedIds.size, "all low-confidence units escalated");

  // Simulate a crash that lost the live count but kept the durable finals: zero
  // the persisted count and mark the run resumable. The escalated final LINES
  // are still on disk.
  await updateProject(
    slug,
    (p) => {
      p.runs[0].status = "paused";
      p.runs[0].escalation.count = 0; // the lost increments
    },
    undefined,
  );
  const linesBefore = await readNdjson(outputsFile(slug, run.id));
  const escalatedOnDisk = linesBefore.filter((l) => l.escalated === true).length;
  assert.equal(escalatedOnDisk, escalatedIds.size, "the escalated finals really are on disk");

  // Resume: nothing is pending (the run was complete), so resume just replays
  // the finals — and must recount escalation from them, not trust the zeroed
  // persisted value.
  const resumed = await engineMod.executeRun(slug, run.id, { concurrency: 1 });
  assert.equal(resumed.status, "complete");
  assert.equal(
    resumed.escalation.count,
    escalatedIds.size,
    "escalation.count is re-derived from the persisted escalated finals, healing the lost increments",
  );
  const onDisk = (await loadProject(slug)).runs[0];
  assert.equal(onDisk.escalation.count, escalatedIds.size, "the healed count persists");
});

// =============================================================================
// 7 — monitor warnings are ring-buffer capped
// =============================================================================

test("fix 7: monitor warnings stay bounded under a flood; the most recent are retained and the drop count is surfaced", () => {
  const runId = "ring-buffer-run";
  monitor.track(runId, { total: 10_000 });
  const FLOOD = 5_000;
  for (let i = 0; i < FLOOD; i++) {
    monitor.warn(runId, {
      kind: "quarantine",
      message: `unit u_${i} quarantined`,
      unitId: `u_${i}`,
      seq: i,
    });
  }
  const s = monitor.runState(runId);
  // the array is capped (NOT FLOOD entries) and the newest warning is retained
  assert.ok(
    s.warnings.length <= 200,
    `warnings capped at ≤200 (got ${s.warnings.length}), not ${FLOOD}`,
  );
  assert.equal(s.warnings.at(-1).seq, FLOOD - 1, "the most recent warning is kept");
  assert.equal(s.warnings.at(-1).unitId, `u_${FLOOD - 1}`);
  // the cap is honest about how many it dropped
  assert.equal(typeof s.warningsDropped, "number");
  assert.equal(
    s.warnings.length + s.warningsDropped,
    FLOOD,
    "every warning is either retained or counted as dropped",
  );
  assert.ok(s.warningsDropped > 0, "the flood really evicted older warnings");
  monitor.clearRun(runId);
});

test("fix 7: a modest warning count is untouched — warningsDropped stays absent (shape unchanged for the common case)", () => {
  const runId = "ring-buffer-small";
  monitor.track(runId, { total: 10 });
  for (let i = 0; i < 5; i++) monitor.warn(runId, { kind: "quarantine", message: `m${i}` });
  const s = monitor.runState(runId);
  assert.equal(s.warnings.length, 5);
  assert.equal(
    s.warningsDropped,
    undefined,
    "no drops → the field stays absent (consumers asserting exact warnings are unaffected)",
  );
  monitor.clearRun(runId);
});

// =============================================================================
// 8 — reserved-slug bypass closed
// =============================================================================

test("fix 8: an EXPLICIT reserved Windows device-name slug is rejected VALIDATION (the regex used to pass it through)", () => {
  for (const bad of ["con", "aux", "nul", "prn", "com1", "lpt9"]) {
    assert.throws(
      () => createProject({ name: "Whatever", slug: bad }),
      (e) => e.code === "VALIDATION" && /reserved device name/i.test(e.message),
      `slug "${bad}" must be rejected as a reserved device name`,
    );
  }
  // a name that SLUGIFIES to a reserved word is still auto-suffixed (the
  // historical convenience for "Con Survey" → "con-…" is intact)
  const ok = createProject({ name: "Con" });
  assert.equal(ok.slug, "con-project", "an auto-derived reserved slug is suffixed, not rejected");
  // a normal explicit slug is unaffected
  assert.equal(createProject({ name: "X", slug: "my-study" }).slug, "my-study");
});

// =============================================================================
// 9 — createProjectIfAbsent is atomic (no check-then-act race)
// =============================================================================

test("fix 9: two concurrent POSTs for the same slug → exactly one succeeds, the other gets a clean VALIDATION (no clobber)", async () => {
  const handler = routeHandler(projectsRoutes, "POST", "/api/projects");
  const body = { name: "Race Project", slug: "race-project", privacyMode: "open" };

  const [a, b] = await Promise.allSettled([
    handler({ body }, null, {}),
    handler({ body }, null, {}),
  ]);

  const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
  const rejected = [a, b].filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one create wins");
  assert.equal(rejected.length, 1, "the other loses");
  assert.equal(
    rejected[0].reason?.code,
    "VALIDATION",
    "the loser gets a clean VALIDATION, not a clobber or a crash",
  );

  // the winner's project is intact on disk
  const onDisk = await loadProject("race-project");
  assert.equal(onDisk.name, "Race Project");
  assert.equal(onDisk.slug, "race-project");
});

test("fix 9: createProjectIfAbsent refuses a present-but-corrupt bundle instead of overwriting it", async () => {
  const slug = "corrupt-bundle";
  const dir = projectDir(slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "project.json"), "{ this is not json", "utf8");

  const p = createProject({ name: "New", slug });
  await assert.rejects(
    () => store.createProjectIfAbsent(p),
    (e) => e.code === "VALIDATION",
    "a damaged-but-real bundle is not silently overwritten",
  );
  // the corrupt file is untouched
  const raw = await readFile(path.join(dir, "project.json"), "utf8");
  assert.equal(raw, "{ this is not json", "the corrupt bundle was left exactly as it was");
});
