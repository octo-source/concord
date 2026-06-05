// Wave-2 integration: the REAL seam between F2 (server/director/*) and
// F1 (server/runs/{engine,monitor}.js + server/instruments/{judge,panel,stability}.js).
//
// F2's unit suite proved silverTune against ENGINE DOUBLES; this file injects
// the real modules (engine = server/runs/engine.js, stability =
// server/instruments/stability.js) and runs the full loop — Director silver
// labels (MockModel handler via project.director.systemSuffix), real worker
// judging through judge.assemble/judgeUnit/Pool/cache, real confusion-driven
// rewrite, real stability promotion, real bundle persistence and ledger.
//
// Conventions copied from the unit suites:
//   - hermetic bundles under a temp CONCORD_PROJECTS_DIR (F2 modules take no
//     {dir} option — they resolve projectsDir() from the env var);
//   - one memoized MockAdapter shared with the modules under test
//     (registry caches per provider+keysPath); handlers are namespaced per
//     test, oracle/accuracy reset at each test head;
//   - fixed project/construct ids wherever a seeded sample must be
//     reproducible across runs (seededSample seeds on project.id).
//
// REGRESSION TESTS (formerly KNOWN-BUG TODOS, now fixed and asserted green):
//   BUG-1  one stabilityCheck ledgers exactly ONE instrument.stability event —
//          server/instruments/stability.js owns the append; silver.js no
//          longer re-appends it.
//   BUG-2  the monitor's drift tripwire re-judge runs against the run's
//          bundle dir — armDriftTripwire accepts {dir} and driftTick forwards
//          it to runEphemeral (no cache pollution under the default
//          projects dir).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ConcordError } from "../../server/core/errors.js";
import { createProject, createConstruct, createInstrument, createAnalysis } from "../../server/core/objects.js";
import { saveProject, loadProject, updateProject, readNdjson, projectDir } from "../../server/core/store.js";
import * as ledger from "../../server/core/ledger.js";
import { unitId } from "../../server/core/ids.js";
import { getAdapter } from "../../server/providers/registry.js";

// F1 — injected REAL into silverTune, and exercised directly.
import * as engineMod from "../../server/runs/engine.js";
import { createRun, executeRun } from "../../server/runs/engine.js";
import * as monitor from "../../server/runs/monitor.js";
import * as stabilityMod from "../../server/instruments/stability.js";

// F2 — the director side of the seam.
import { silverTune } from "../../server/director/silver.js";
import { compileInstrument, acceptInstrument } from "../../server/director/compiler.js";
import { makeEscalator } from "../../server/director/escalate.js";
import { suggestAnalyses } from "../../server/director/analyst.js";
import { generateBrief } from "../../server/director/brief.js";
import { compileQuestion, approvePlan } from "../../server/director/questionbar.js";
import { directorCosts } from "../../server/director/director.js";

// ---------------------------------------------------------------- harness

let tmpRoot;
before(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "concord-orch-"));
  process.env.CONCORD_PROJECTS_DIR = tmpRoot;
});
after(async () => {
  delete process.env.CONCORD_PROJECTS_DIR;
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

// Same memoized instance the modules under test resolve via the registry.
const mock = getAdapter({ privacyMode: "open" }, "mock").adapter;

const ORACLE = (text) => (text.includes("salary") ? "yes" : "no");
const CORPUS_ID = "corpus1"; // fixed → unit ids and brief samples deterministic

// Project bundle + planted corpus. Director slot carries the MockModel
// handler marker through systemSuffix — production's researcher-customization
// field, the pinned test seam.
async function makeProject({ slug, id, handler, n, textOf, director = true }) {
  const project = createProject({
    id,
    name: slug,
    slug,
    privacyMode: "open",
    director: director
      ? { provider: "mock", model: "mock-1", snapshot: "mock-1", systemSuffix: `[[handler:${handler}]]` }
      : null,
  });
  await saveProject(project);
  const units = Array.from({ length: n }, (_, i) => {
    const text = textOf(i);
    return {
      id: unitId(CORPUS_ID, i, text),
      text,
      meta: { dept: i % 2 ? "sales" : "ops", tenure: 1 + (i % 5) },
      pos: { row: i },
    };
  });
  const cdir = path.join(projectDir(slug), "corpora", CORPUS_ID);
  await mkdir(cdir, { recursive: true });
  await writeFile(path.join(cdir, "units.ndjson"), units.map((u) => JSON.stringify(u)).join("\n") + "\n", "utf8");
  Object.assign(project, await updateProject(slug, (p) => {
    p.corpora.push({ id: CORPUS_ID, name: "Survey responses", unitCount: n });
  }));
  return { project, corpusId: CORPUS_ID, units };
}

function payConstruct(id) {
  return createConstruct({
    id,
    name: "Pay complaint",
    type: "binary",
    definition: "The unit complains about compensation level or fairness.",
    criteria: {
      include: ["names compensation as a problem"],
      exclude: ["benefits-only complaints"],
    },
    edgeCases: ["sarcastic praise of compensation counts as a complaint"],
    examples: [
      { text: "What they give us for this work is insulting.", label: "yes", kind: "positive" },
      { text: "Great team, decent comp.", label: "no", kind: "negative" },
    ],
    categories: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
    authoredBy: "director",
    humanTouched: false,
  });
}

const lastUser = (req) => [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
const shownUnitIds = (text) => [...new Set([...String(text).matchAll(/unit (u_[0-9a-f]{16})/g)].map((m) => m[1]))];

function assertExactlyOnce(lines) {
  const seen = new Set();
  for (const l of lines) {
    const k = `${l.unitId}|${l.juror}`;
    assert.ok(!seen.has(k), `duplicate output line ${k}`);
    seen.add(k);
  }
}

// =============================================================================
// (b) silverTune against the REAL engine and REAL stability module
// =============================================================================

let silverState = null; // consumed by the BUG-1 regression test below

test("silverTune: real engine + real stability — loop runs, curve recorded, promotion fires, goldset persists with pi, ledger in order", async () => {
  const slug = "orch-silver";
  const yes = (i) => i % 3 === 0; //  100 / 300 planted positives
  const edge = (i) => i % 21 === 0; //  15 units; 21 % 3 === 0 → all inside the yes theme
  const { project, units } = await makeProject({
    slug,
    id: "p_orchsilver000001", // FIXED: seededSample seeds on project.id — sample must be reproducible
    handler: "dir-silver",
    n: 300,
    textOf: (i) =>
      (`Response ${String(i).padStart(3, "0")}: ` +
        (yes(i)
          ? `the salary is too low for this work${edge(i) ? " EDGEC" : ""} and it never improves`
          : "the office is comfortable and the team is genuinely kind")
      ).padEnd(120, "."),
  });
  const byId = new Map(units.map((u) => [u.id, u]));

  // Worker truth = planted theme; Director silver labels DISAGREE on the EDGEC
  // units (silver says "no") → a real confusion for the rewrite loop to chew on.
  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);
  let rewrites = 0;
  let rewritePromptSeen = null;
  mock.setHandler("dir-silver", (req) => {
    const user = lastUser(req);
    if (req.schema?.properties?.promptTemplate) {
      rewrites++;
      rewritePromptSeen = user;
      return {
        promptTemplate: `Revised v${rewrites}: sharpen the edge-case rule. {{definition}} {{criteria}} {{examples}} {{unit}}`,
        note: `targeted the planted confusion (${rewrites})`,
      };
    }
    // silver labeling: one rendered unit per call — label from the planted map
    const ids = shownUnitIds(user);
    const u = byId.get(ids[ids.length - 1]);
    assert.ok(u, "silver-label call must render a known unit");
    return {
      rationale: "Applying the codebook as written.",
      label: edge(u.pos.row) ? "no" : ORACLE(u.text),
      confidence: 0.97,
    };
  });

  const construct = payConstruct("c_pay");
  Object.assign(project, await updateProject(slug, (p) => { p.constructs.push(construct); }));

  // Raw-escape-hatch compile (no Director call) so director-call accounting
  // below is exact; the Director-compile path is exercised in the pipeline test.
  const instrument = await compileInstrument(project, construct, {
    workerClass: "mid",
    provider: "mock",
    model: "mock-1",
    snapshot: "mock-1",
    promptTemplate: "Initial template. {{definition}} {{criteria}} {{examples}} {{unit}}",
  });
  assert.deepEqual(instrument.payload.schema, { type: "binary", options: ["yes", "no"] },
    "compileInstrument resolved the REAL judge.outputSchemaFor via dynamic import");
  await acceptInstrument(project, instrument);
  Object.assign(project, await loadProject(slug));

  // ---- the seam call: REAL modules injected, exactly as routes will pass them
  const iterations = [];
  const { instrument: tuned, curve, cost } = await silverTune(project, instrument, units, {
    engine: engineMod,        // server/runs/engine.js — NOT a double
    stability: stabilityMod,  // server/instruments/stability.js — NOT a double
    onIteration: (it) => iterations.push(it),
  });

  // ---- silver GoldSet persisted with pi
  const fresh = await loadProject(slug);
  assert.equal(fresh.goldsets.length, 1);
  const gsMeta = fresh.goldsets[0];
  assert.equal(gsMeta.tier, "silver");
  assert.equal(gsMeta.n, 200, "default n=200 sample");
  const gs = JSON.parse(await readFile(path.join(projectDir(slug), "gold", `${gsMeta.id}.json`), "utf8"));
  assert.equal(gs.status, "complete");
  assert.equal(gs.constructId, construct.id);
  assert.equal(gs.sample.length, 200);
  assert.ok(gs.sample.every((s) => s.pi === 200 / 300), "pi = n/N recorded on every sample row");
  assert.equal(gs.coders.length, 1);
  assert.equal(gs.coders[0].coderId, "director");
  assert.equal(Object.keys(gs.coders[0].labels).length, 200, "Director labeled the full sample");

  // ---- the curve: deterministic planted agreement, plateau after 2 points
  const m = gs.sample.filter((s) => edge(byId.get(s.unitId).pos.row)).length;
  assert.ok(m >= 1 && m <= 15, `planted EDGEC units must land in the sample (got ${m})`);
  const planted = (200 - m) / 200;
  assert.equal(curve.length, 2, "iteration 2 repeats iteration 1 exactly (accuracy 1.0) → plateau");
  assert.equal(curve[0].agreement, planted, "iteration-1 agreement is exactly the planted disagreement rate");
  assert.equal(curve[1].agreement, planted);
  assert.equal(rewrites, 1, "exactly one confusion-driven rewrite before the plateau");
  assert.match(rewritePromptSeen, /EDGEC/, "the rewrite prompt carried real confused-unit evidence");
  assert.notEqual(curve[0].versionHash, curve[1].versionHash, "each iteration ran a distinct instrument version");
  assert.equal(tuned.versionHash, curve[1].versionHash);
  assert.equal(tuned.version, 2);
  assert.match(tuned.payload.promptTemplate, /Revised v1/, "the Director's rewrite is the final template");
  for (const point of curve) {
    assert.ok("kappa" in point && "alpha" in point, "κ/α recorded alongside percent agreement");
    assert.equal(typeof point.agreement, "number");
    assert.equal(typeof point.costUSD, "number", "per-iteration spend recorded on the curve");
  }
  assert.deepEqual(iterations.map((i) => i.iteration), [1, 2], "onIteration streamed in order");

  // ---- promotion: real stabilityCheck passed (accuracy 1.0 → α = 1) + ≥1 iteration → ◑
  assert.equal(tuned.level, "stabilized", "level promotion fired off the REAL stability verdict");
  assert.equal(tuned.stability.alpha, 1);
  assert.equal(tuned.stability.k, 3);
  assert.equal(tuned.silver.goldsetId, gsMeta.id);
  assert.equal(tuned.silver.iterations.length, 2);
  const persisted = fresh.instruments.find((i) => i.id === instrument.id);
  assert.equal(persisted.level, "stabilized");
  assert.equal(persisted.versionHash, tuned.versionHash, "tuned version persisted to the bundle");

  // ---- the REAL engine ran: content-addressed cache materialized in the bundle
  assert.ok(existsSync(path.join(projectDir(slug), "cache")), "runEphemeral wrote the bundle cache (proof the real engine served the loop)");

  // ---- ledger: taxonomy order + actor conventions. The stability module is
  // the sole owner of the instrument.stability append (stability.js:113);
  // silver.js does not re-append it (BUG-1 fix) — exactly one event per check.
  const pdir = projectDir(slug);
  const all = await ledger.query(pdir, {});
  const interesting = new Set(["instrument.compiled", "goldset.created", "goldset.completed", "instrument.stability", "instrument.silver_tuned"]);
  const seq = all.filter((e) => interesting.has(e.type)).map((e) => `${e.type}:${e.actor}`);
  assert.deepEqual(seq, [
    "instrument.compiled:human",      // acceptance is the human act
    "goldset.created:director",       // generation is the director act
    "goldset.completed:director",
    "instrument.stability:system",    // mechanical check (REAL stability module — the ONLY appender)
    "instrument.silver_tuned:director",
  ], "ledger event order + actor conventions across the seam");
  assert.equal((await ledger.verify(pdir)).ok, true);

  // ---- director metering: 200 silver labels + 1 rewrite, all $0 on mock
  const costs = directorCosts(project);
  assert.equal(costs.calls, 201, "200 silver-label calls + 1 rewrite call");
  assert.equal(costs.usd, 0);
  assert.ok(costs.inputTokens > 0 && costs.outputTokens > 0);

  // ---- cost channel: worker + director silver spend surfaced for budgeting
  // (both $0 on mock catalog pricing, but the FIELDS must be there)
  assert.deepEqual(cost, { workerUSD: 0, directorUSD: 0 }, "silverTune returns cost: {workerUSD, directorUSD}");
  for (const point of curve) assert.equal(point.costUSD, 0, "mock iterations cost $0");

  silverState = { pdir, instrumentId: instrument.id };
});

test("BUG-1 regression: one stability check ledgers exactly ONE instrument.stability event (stability.js owns the append)", async () => {
  assert.ok(silverState, "depends on the silver integration test above");
  const events = await ledger.query(silverState.pdir, { type: "instrument.stability", ref: silverState.instrumentId });
  assert.equal(
    events.length, 1,
    `found ${events.length} instrument.stability events for ONE stabilityCheck — the real stability module appends ` +
    "the event (stability.js:113) and silver.js must not re-append it, or methods/replication that count stability " +
    "runs from the ledger will double-count",
  );
});

// =============================================================================
// silverTune {capUSD}: budget stop between iterations, partial tune valid
// =============================================================================

test("silverTune: a tiny {capUSD} stops cleanly after iteration 1 — stoppedBy budget, curve note, no rewrite paid for, partial tune valid", async (t) => {
  const slug = "orch-cap";
  const { project, units } = await makeProject({
    slug,
    id: "p_orchcap00000001",
    handler: "dir-cap",
    n: 30,
    textOf: (i) => `Response ${i}: ${i % 3 === 0 ? "the salary is low" : "the chairs are fine"}`.padEnd(60, "."),
  });
  const byId = new Map(units.map((u) => [u.id, u]));
  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);
  let rewrites = 0;
  mock.setHandler("dir-cap", (req) => {
    if (req.schema?.properties?.promptTemplate) {
      rewrites++;
      return { promptTemplate: "R {{definition}} {{criteria}} {{examples}} {{unit}}", note: "n" };
    }
    const ids = shownUnitIds(lastUser(req));
    const u = byId.get(ids[ids.length - 1]);
    return { rationale: "r", label: ORACLE(u?.text ?? ""), confidence: 0.95 };
  });

  // Nonzero catalog pricing → the worker pass costs real (fake) dollars, so a
  // tiny cap trips after iteration 1. (The engine reads pricing per run;
  // director.js's pricing cache was already warmed at the mock's real $0.)
  const origCatalog = mock.catalog;
  mock.catalog = async () => [
    { id: "mock-1", name: "Mock", family: "mock", ctx: 128_000, pricing: { inUSDper1M: 1000, outUSDper1M: 1000 }, snapshot: "mock-1" },
  ];
  t.after(() => { mock.catalog = origCatalog; });

  const construct = payConstruct("c_cap");
  Object.assign(project, await updateProject(slug, (p) => { p.constructs.push(construct); }));
  const instrument = await compileInstrument(project, construct, {
    workerClass: "mid", provider: "mock", model: "mock-1", snapshot: "mock-1",
    promptTemplate: "T {{definition}} {{criteria}} {{examples}} {{unit}}",
  });
  await acceptInstrument(project, instrument);
  Object.assign(project, await loadProject(slug));

  const res = await silverTune(project, instrument, units, {
    engine: engineMod, stability: stabilityMod, n: 12, capUSD: 1e-6,
  });

  assert.equal(res.stoppedBy, "budget", "the cap stopped the loop");
  assert.equal(res.curve.length, 1, "exactly iteration 1 ran before the budget stop");
  assert.equal(rewrites, 0, "the stop preempts the next iteration's Director rewrite — nothing paid for it");
  assert.match(res.curve[0].note, /budget/i, "the budget stop is recorded on the curve");
  assert.ok(res.cost.workerUSD >= 1e-6, `accumulated worker spend crossed the cap (got ${res.cost.workerUSD})`);
  assert.equal(typeof res.cost.directorUSD, "number");
  assert.equal(res.curve[0].costUSD, res.cost.workerUSD,
    "iteration 1 carries the whole worker spend (silver labeling stays out of per-iteration costs)");

  // the partial tune remains a valid artifact: goldset + curve + stability
  // verdict persisted on the (unrewritten) version-1 instrument
  const tuned = res.instrument;
  assert.equal(tuned.version, 1, "no rewrite happened — still version 1");
  assert.equal(tuned.silver.iterations.length, 1);
  assert.equal(tuned.silver.iterations[0].agreement, 1, "the one compared pass is on the curve");
  const pdir = projectDir(slug);
  assert.equal((await ledger.query(pdir, { type: "instrument.silver_tuned" })).length, 1);
  assert.equal((await ledger.verify(pdir)).ok, true);
});

// =============================================================================
// (3) error propagation across the boundary: refusals and outages inside
//     silverTune's REAL runEphemeral
// =============================================================================

// Worker-only fault injection: Director calls carry the [[handler:...]] marker
// in their system message and pass through untouched.
function patchWorkerCalls(t, fn) {
  const proto = Object.getPrototypeOf(mock);
  const orig = proto.complete;
  mock.complete = async function patched(req) {
    const sys = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    if (!sys.includes("[[handler:")) {
      const out = fn(req);
      if (out !== undefined) return out; // a thrown error escapes fn before this
    }
    return orig.call(this, req);
  };
  t.after(() => { delete mock.complete; }); // fall back to the prototype method
}

test("silverTune: a PROVIDER_REFUSAL inside the real engine quarantines that unit; the loop continues over the compared rest", async (t) => {
  const slug = "orch-refusal";
  const { project, units } = await makeProject({
    slug,
    id: "p_orchrefusal00001",
    handler: "dir-refusal",
    n: 12,
    textOf: (i) =>
      (`Response ${i}: ` +
        (i === 5
          ? "the salary REFUSEME story they do not want repeated"
          : i % 3 === 0
            ? "the salary is too low for this work"
            : "the office is comfortable and calm")
      ).padEnd(80, "."),
  });
  const byId = new Map(units.map((u) => [u.id, u]));
  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);
  mock.setHandler("dir-refusal", (req) => {
    const user = lastUser(req);
    if (req.schema?.properties?.promptTemplate) {
      return { promptTemplate: "R2 {{definition}} {{criteria}} {{examples}} {{unit}}", note: "n" };
    }
    const ids = shownUnitIds(user);
    const u = byId.get(ids[ids.length - 1]);
    return { rationale: "r", label: ORACLE(u.text), confidence: 0.95 };
  });
  patchWorkerCalls(t, (req) => {
    if (lastUser(req).includes("REFUSEME")) {
      throw new ConcordError("PROVIDER_REFUSAL", "provider refused this content", {});
    }
  });

  const construct = payConstruct("c_refusal");
  Object.assign(project, await updateProject(slug, (p) => { p.constructs.push(construct); }));
  const instrument = await compileInstrument(project, construct, {
    workerClass: "mid", provider: "mock", model: "mock-1", snapshot: "mock-1",
    promptTemplate: "T {{definition}} {{criteria}} {{examples}} {{unit}}",
  });
  await acceptInstrument(project, instrument);
  Object.assign(project, await loadProject(slug));

  // n = 12 ≥ corpus → the sample is ALL units, refused one included
  const { instrument: tuned, curve } = await silverTune(project, instrument, units, {
    engine: engineMod, stability: stabilityMod, n: 12,
  });

  // Director labeled all 12; the worker never produced the refused unit → it
  // is silently dropped from the comparison (not crashed, not mislabeled).
  const gs = JSON.parse(await readFile(
    path.join(projectDir(slug), "gold", `${tuned.silver.goldsetId}.json`), "utf8"));
  assert.equal(Object.keys(gs.coders[0].labels).length, 12);
  assert.equal(curve[0].agreement, 1, "agreement computed over the 11 compared (non-refused) units");
  assert.equal(tuned.level, "stabilized", "refusal of one unit does not block promotion");
  assert.equal((await ledger.verify(projectDir(slug))).ok, true);
});

test("silverTune: PROVIDER_UNREACHABLE inside the real engine propagates after Pool retries; goldset survives, instrument is NOT silver_tuned", async (t) => {
  const slug = "orch-down";
  const { project, units } = await makeProject({
    slug,
    id: "p_orchdown0000001",
    handler: "dir-down",
    n: 8,
    textOf: (i) => `Response ${i}: ${i % 3 === 0 ? "the salary is low" : "the chairs are fine"}`.padEnd(60, "."),
  });
  const byId = new Map(units.map((u) => [u.id, u]));
  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);
  mock.setHandler("dir-down", (req) => {
    const ids = shownUnitIds(lastUser(req));
    const u = byId.get(ids[ids.length - 1]);
    return { rationale: "r", label: ORACLE(u?.text ?? ""), confidence: 0.95 };
  });
  patchWorkerCalls(t, () => {
    throw new ConcordError("PROVIDER_UNREACHABLE", "connect ECONNREFUSED (injected)", { kind: "TypeError" });
  });

  const construct = payConstruct("c_down");
  Object.assign(project, await updateProject(slug, (p) => { p.constructs.push(construct); }));
  const instrument = await compileInstrument(project, construct, {
    workerClass: "mid", provider: "mock", model: "mock-1", snapshot: "mock-1",
    promptTemplate: "T {{definition}} {{criteria}} {{examples}} {{unit}}",
  });
  await acceptInstrument(project, instrument);
  Object.assign(project, await loadProject(slug));

  await assert.rejects(
    silverTune(project, instrument, units, { engine: engineMod, stability: stabilityMod, n: 8 }),
    (err) => {
      assert.equal(err.code, "PROVIDER_UNREACHABLE", "infrastructure faults keep their identity across the seam");
      return true;
    },
  );

  // Partial-state contract: the (expensive) Director silver labels persisted;
  // the tuning loop never concluded — no silver_tuned event, instrument
  // untouched on disk.
  const pdir = projectDir(slug);
  assert.equal((await ledger.query(pdir, { type: "goldset.created" })).length, 1, "silver labels are not lost to a worker outage");
  assert.equal((await ledger.query(pdir, { type: "instrument.silver_tuned" })).length, 0);
  const fresh = await loadProject(slug);
  const inst = fresh.instruments.find((i) => i.id === instrument.id);
  assert.equal(inst.level, "exploratory");
  assert.equal(inst.version, 1);
  assert.equal(inst.silver, undefined);
  assert.equal((await ledger.verify(pdir)).ok, true);
});

// =============================================================================
// <unit> wrapper ownership: judge.assemble wraps the unit at run time;
// templates (authored, scaffolded, or legacy) never yield a second pair
// =============================================================================

test("unit wrapper: assembled worker messages carry exactly ONE <unit>/</unit> pair — scaffolded slot and legacy templates alike", async (t) => {
  const slug = "orch-unitwrap";
  const { project, units } = await makeProject({
    slug,
    id: "p_orchwrap0000001",
    handler: "dir-wrap",
    n: 3,
    textOf: (i) => `Response ${i}: the salary is low and the chairs are fine`.padEnd(70, "."),
  });
  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);
  // The Director "forgets" the unit slot — the compiler's deterministic
  // scaffolding appends prompts.SLOT_SECTIONS["{{unit}}"], which must carry
  // the BARE slot: judge.assemble owns the <unit> wrapper.
  mock.setHandler("dir-wrap", () => ({
    promptTemplate: "Wrap judge. {{definition}} {{criteria}} {{examples}}",
    note: "no unit slot — scaffolding appends it",
  }));
  const construct = payConstruct("c_wrap");
  Object.assign(project, await updateProject(slug, (p) => { p.constructs.push(construct); }));

  // Capture only THIS test's worker calls (template heads "Wrap judge." /
  // "Legacy judge.") — detached stragglers from a previous test's aborted
  // pool can still land on the shared mock while this test runs.
  const seen = [];
  patchWorkerCalls(t, (req) => {
    const all = req.messages.map((m) => m.content).join("\n");
    if (/^(Wrap|Legacy) judge\./m.test(all)) seen.push(all);
  });
  const count = (text, token) => text.split(token).length - 1;

  const scaffolded = await compileInstrument(project, construct, {
    workerClass: "frontier", provider: "mock", model: "mock-1", snapshot: "mock-1",
  });
  assert.ok(scaffolded.payload.promptTemplate.includes("{{unit}}"), "scaffolding appended the unit slot");
  assert.ok(!scaffolded.payload.promptTemplate.includes("<unit>"),
    "templates reference the BARE {{unit}} slot — judge.assemble owns the <unit> wrapper");
  await engineMod.runEphemeral(project, scaffolded, units.slice(0, 1), {});

  // Legacy templates that still write <unit>{{unit}}</unit> (pre-fix bundles,
  // Director rewrites that ignore instructions) must not double-wrap either.
  const legacy = await compileInstrument(project, construct, {
    workerClass: "frontier", provider: "mock", model: "mock-1", snapshot: "mock-1",
    promptTemplate: "Legacy judge. {{definition}} {{criteria}} {{examples}} <unit>{{unit}}</unit>",
  });
  await engineMod.runEphemeral(project, legacy, units.slice(1, 2), {});

  assert.equal(seen.length, 2, "both ephemeral judges reached the worker");
  for (const messages of seen) {
    assert.equal(count(messages, "<unit>"), 1, `exactly one <unit> open tag in the assembled messages:\n${messages}`);
    assert.equal(count(messages, "</unit>"), 1, `exactly one </unit> close tag in the assembled messages:\n${messages}`);
  }
});

// =============================================================================
// (c) full pipeline smoke: Director-compiled instrument → createRun →
//     executeRun with makeEscalator wired in → monitor → analyst
// =============================================================================

test("pipeline: compileInstrument (mock director) → createRun → executeRun + makeEscalator → monitor sane → suggestAnalyses materializable", async () => {
  const slug = "orch-pipe";
  const yes = (i) => i % 3 === 0;
  const LONG = 7; // 7 % 3 !== 0 — the one atypically long unit (≫ p99 → escalates)
  const { project, corpusId, units } = await makeProject({
    slug,
    id: "p_orchpipe0000001",
    handler: "dir-pipe",
    n: 300,
    textOf: (i) =>
      i === LONG
        ? `Response ${i}: ` + "the salary conversation keeps coming back and nobody addresses it properly. ".repeat(10)
        : (`Response ${String(i).padStart(3, "0")}: ` +
            (yes(i) ? "the salary is too low for this work" : "the office is comfortable and calm")
          ).padEnd(100, "."),
  });
  const longUnit = units[LONG];

  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);
  const escalationsSeen = [];
  mock.setHandler("dir-pipe", (req) => {
    const user = lastUser(req);
    if (req.schema?.properties?.promptTemplate) {
      // instrument compilation
      return {
        promptTemplate: "Pipeline judge. {{definition}} {{criteria}} {{examples}} {{unit}}",
        note: "lean frontier frame",
      };
    }
    if (req.schema?.properties?.reason) {
      // escalation second opinion: disagree with the worker's "yes"
      escalationsSeen.push(user);
      return {
        rationale: "The unit is repetitive boilerplate; no concrete compensation complaint is made.",
        label: "no",
        confidence: 0.95,
        reason: "Worker over-weighted sheer repetition of the word salary.",
      };
    }
    if (req.schema?.properties?.suggestions) {
      // analyst — refs from the outputs sample it was shown (+1 bogus)
      const ids = shownUnitIds(user);
      return {
        suggestions: [
          {
            kind: "crosstab",
            spec: { rowKey: "label", colKey: "dept", instrumentId: "filled-below", corpusId },
            annotation: "Pay complaints look unevenly distributed across departments.",
            evidenceRefs: [ids[0], "u_00000000000000ff"],
          },
          {
            kind: "descriptive",
            spec: { of: "label", corpusId },
            annotation: "Overall prevalence of pay complaints.",
            evidenceRefs: [],
          },
        ],
      };
    }
    throw new Error(`dir-pipe handler got an unexpected Director request: ${JSON.stringify(req.schema?.properties ? Object.keys(req.schema.properties) : null)}`);
  });

  const construct = payConstruct("c_pipe");
  Object.assign(project, await updateProject(slug, (p) => { p.constructs.push(construct); }));

  // Director-compiled instrument (no escape hatch): real compile prompt → handler
  const instrument = await compileInstrument(project, construct, {
    workerClass: "frontier", provider: "mock", model: "mock-1", snapshot: "mock-1",
  });
  assert.equal(instrument.authoredBy, "director");
  assert.equal(instrument.humanTouched, false);
  for (const slot of ["{{definition}}", "{{criteria}}", "{{examples}}", "{{unit}}"]) {
    assert.ok(instrument.payload.promptTemplate.includes(slot), `compiled template carries ${slot}`);
  }
  await acceptInstrument(project, instrument);
  Object.assign(project, await loadProject(slug));

  // createRun: preflight estimate + pending run + ledger
  const run = await createRun(project, { instrumentId: instrument.id, corpusId });
  assert.equal(run.status, "pending");
  assert.deepEqual(run.checkpoint, { done: 0, total: 300 });
  assert.equal(typeof run.cost.estUSD, "number");
  assert.equal(run.cost.estUSD, 0, "mock catalog pricing is $0");
  assert.equal(run.pinned, true);

  // executeRun with the REAL F2 escalator wired into the F1 engine seam
  const escalate = makeEscalator(project, construct);
  let lastTick = null;
  const done = await executeRun(slug, run.id, { escalate, onTick: (s) => { lastTick = s; } });
  assert.equal(done.status, "complete");
  assert.deepEqual(done.checkpoint, { done: 300, total: 300 });
  assert.equal(done.quarantine.length, 0);
  assert.equal(done.escalation.count, 1, "exactly the one ≫p99 unit escalated");
  assert.equal(escalationsSeen.length, 1);
  assert.match(escalationsSeen[0], /yes/, "the Director saw the worker's verdict");
  assert.equal(done.cost.actualUSD, 0);
  assert.ok(done.cost.inputTokens > 0 && done.cost.outputTokens > 0);

  // outputs complete, exactly-once; the escalated line carries the Director's replacement
  const pdir = projectDir(slug);
  const lines = await readNdjson(path.join(pdir, "runs", run.id, "outputs.ndjson"));
  assert.equal(lines.length, 300);
  assertExactlyOnce(lines);
  const escalated = lines.filter((l) => l.escalated);
  assert.equal(escalated.length, 1);
  assert.equal(escalated[0].unitId, longUnit.id);
  assert.equal(escalated[0].label, "no", "Director replacement label landed on the written line");
  assert.equal(escalated[0].confidence, 0.95);
  assert.match(escalated[0].rationale, /^Worker over-weighted .* — /, "reason-first rationale from makeEscalator");
  // Engine contract: the line KEEPS the worker's juror hash (resume keys on
  // it) while the Director's replacement contributes label/confidence/
  // rationale AND its escalatedBy provenance marker — so the disagreement
  // view can distinguish a Director override structurally instead of parsing
  // rationale text.
  assert.equal(escalated[0].juror, instrument.versionHash, "the worker's juror hash stays on the line (resume semantics)");
  assert.equal(escalated[0].escalatedBy, "director", "the Director's provenance marker lands on the written line");
  assert.ok(lines.filter((l) => !l.escalated).every((l) => l.escalatedBy === undefined),
    "non-escalated lines carry no provenance marker");

  // monitor telemetry was sane THROUGH the run (the final tick saw everything)…
  assert.equal(lastTick.done, 300);
  assert.equal(lastTick.total, 300);
  assert.equal(lastTick.escalations, 1);
  assert.equal(lastTick.costUSD, 0);
  assert.deepEqual(lastTick.labelDist, { yes: 100, no: 200 }, "planted distribution, with the escalated unit flipped to no");
  assert.deepEqual(lastTick.warnings, [], "no degenerate/drift/quarantine warnings on a healthy run");
  // …and the engine cleared the run's state at completion (monitor hygiene:
  // complete/failed clear; paused/aborted keep state for the expected resume)
  assert.equal(monitor.runState(run.id), null, "complete run clears monitor state");

  // ledger: this run's events in taxonomy order, all actor system
  const runEvents = (await ledger.query(pdir, { ref: run.id })).map((e) => `${e.type}:${e.actor}`);
  assert.deepEqual(runEvents, [
    "run.preflight:system",
    "run.started:system",
    "run.completed:system",
    "run.escalation_summary:system",
  ]);
  assert.equal((await ledger.verify(pdir)).ok, true);

  // analyst over the REAL outputs: specs must satisfy objects.createAnalysis
  const sample = lines.slice(0, 20);
  const suggestions = await suggestAnalyses(project, done, sample);
  assert.equal(suggestions.length, 2);
  for (const s of suggestions) {
    const analysis = createAnalysis({ kind: s.kind, spec: s.spec }); // materializable today
    assert.equal(analysis.kind, s.kind);
  }
  const sampleIds = new Set(sample.map((o) => o.unitId));
  assert.equal(suggestions[0].evidenceRefs.length, 1, "bogus evidence ref filtered");
  assert.ok(suggestions[0].evidenceRefs.every((r) => sampleIds.has(r)));
});

// =============================================================================
// (d) generateBrief against the real corpus
// =============================================================================

test("brief: generateBrief over the real corpus — refs validated, invalid refs counted, artifact + ledger persist, paragraphs stream in order", async () => {
  const slug = "orch-brief";
  const { project, corpusId, units } = await makeProject({
    slug,
    id: "p_orchbrief000001",
    handler: "dir-brief",
    n: 120,
    textOf: (i) =>
      `Response ${i}: ${i % 3 === 0 ? "the salary is too low" : "the team is kind"}. ` +
      "Detail. ".repeat(i % 9), // varied lengths → non-degenerate terciles
  });

  let briefIds = null;
  mock.setHandler("dir-brief", (req) => {
    const ids = shownUnitIds(lastUser(req));
    briefIds = ids;
    assert.ok(ids.length >= 8, "the Director must be shown a real sample");
    return {
      unitOfAnalysis: "One survey response per row.",
      paragraphs: [
        { md: "Respondents talk mostly about compensation.", refs: [ids[0], ids[1]] },
        { md: "A second cluster praises the team.", refs: [ids[2]] },
      ],
      themes: [
        { name: "Pay", definition: "Complaints about compensation level.", quoteRefs: [ids[0], ids[3], ids[4]] },
      ],
      redFlags: [
        { kind: "junk", detail: "One unit looks like filler.", refs: ["u_beefbeefbeefbeef", ids[5]] }, // 1 invalid + 1 valid
      ],
      suggestedQuestions: ["Which departments complain about pay?"],
    };
  });

  const streamed = [];
  const brief = await generateBrief(project, corpusId, {
    onParagraph: (p, i) => streamed.push({ i, refs: p.refs }),
  });

  assert.match(brief.id, /^brief_/);
  assert.equal(brief.authoredBy, "director");
  assert.equal(brief.sample.n, 120, "small corpus → brief reads everything");
  const validIds = new Set(brief.sample.unitIds);
  for (const p of brief.paragraphs) {
    assert.ok(p.refs.length >= 1);
    for (const r of p.refs) assert.ok(validIds.has(r), `paragraph ref ${r} must be a shown unit`);
  }
  assert.deepEqual(brief.themes[0].quoteRefs, [briefIds[0], briefIds[3], briefIds[4]]);
  assert.deepEqual(brief.redFlags[0].refs, [briefIds[5]], "invalid ref dropped from redFlags");
  assert.equal(brief.issues.invalidRefs, 1, "the dropped ref is counted, not hidden");
  assert.deepEqual(streamed.map((s) => s.i), [0, 1], "paragraphs streamed in order for SSE relay");

  // persistence: artifact file + project registry + ledger
  const onDisk = JSON.parse(await readFile(path.join(projectDir(slug), "briefs", `${brief.id}.json`), "utf8"));
  assert.equal(onDisk.id, brief.id);
  const fresh = await loadProject(slug);
  assert.equal(fresh.briefs.length, 1);
  assert.equal(fresh.briefs[0].id, brief.id);
  const ev = await ledger.query(projectDir(slug), { type: "brief.generated" });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].actor, "director");
  assert.equal(ev[0].payload.invalidRefs, 1);
  assert.ok(units.length > 0); // (lint appeasement: units used above via corpus)
});

// =============================================================================
// (e) questionbar: compileQuestion → approvePlan → instruments materialize →
//     preflight estimate present
// =============================================================================

test("questionbar: compileQuestion → approvePlan materializes against REAL judge.outputSchemaFor → createRun preflight estimate present", async (t) => {
  const slug = "orch-qbar";
  const { project, corpusId, units } = await makeProject({
    slug,
    id: "p_orchqbar0000001",
    handler: "dir-qbar",
    n: 60,
    textOf: (i) => `Response ${i}: ${i % 3 === 0 ? "the salary is too low" : "the team is kind"}`.padEnd(70, "."),
  });

  // Hermetic candidate catalogs: the two network-backed ones go empty (the
  // anthropic/openai catalogs are static offline lists; mock serves the plan).
  for (const name of ["openrouter", "ollama"]) {
    const { adapter } = getAdapter(project, name);
    const orig = adapter.catalog;
    adapter.catalog = async () => [];
    t.after(() => { adapter.catalog = orig; });
  }

  mock.setHandler("dir-qbar", (req) => {
    if (req.schema?.properties?.promptTemplate) {
      return { promptTemplate: "Plan judge. {{definition}} {{criteria}} {{examples}} {{unit}}", note: "compiled for approval" };
    }
    return {
      constructs: [{
        name: "Pay complaint",
        type: "binary",
        definition: "The unit complains about compensation.",
        criteria: { include: ["names pay as a problem"], exclude: ["benefits-only"] },
        edgeCases: [],
        examples: [{ text: units[0].text, label: "yes", kind: "positive" }],
        categories: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
      }],
      instruments: [{ construct: "Pay complaint", workerClass: "small", provider: "mock", model: "mock-1", snapshot: "mock-1" }],
      analysis: {
        kind: "crosstab",
        spec: { rowKey: "label", colKey: "dept", corpusId },
        annotation: "Pay complaints by department answer the question.",
      },
    };
  });

  const plan = await compileQuestion(project, corpusId, "Which departments complain about pay?");
  assert.equal(plan.status, "proposed");
  assert.equal(plan.constructs.length, 1);
  assert.equal(plan.instruments.length, 1);
  assert.equal(plan.instruments[0].constructId, plan.constructs[0].id);
  // preflight estimate on the PLAN
  assert.equal(plan.estimate.calls, 60, "one call per unit per instrument");
  assert.equal(plan.estimate.usd, 0);
  assert.ok(plan.estimate.etaMin > 0);
  assert.ok(plan.estimate.inputTokens > 0 && plan.estimate.outputTokens > 0);
  assert.equal(plan.estimate.perInstrument.length, 1);

  // approval: passes a STALE in-memory project on purpose — approvePlan must
  // re-read the plan from disk. No outputSchemaFor injected: the REAL
  // server/instruments/judge.js export is resolved across the seam.
  const approved = await approvePlan(project, plan.planId);
  assert.deepEqual(approved.constructIds, [plan.constructs[0].id]);
  assert.equal(approved.instrumentIds.length, 1);

  const fresh = await loadProject(slug);
  assert.equal(fresh.plans[0].status, "approved");
  const inst = fresh.instruments.find((i) => i.id === approved.instrumentIds[0]);
  assert.ok(inst, "instrument materialized");
  assert.deepEqual(inst.payload.schema, { type: "binary", options: ["yes", "no"] },
    "payload schema came from the REAL judge.outputSchemaFor");
  assert.match(inst.payload.promptTemplate, /Respond ONLY with a single JSON object/,
    "small-class strict block enforced at approval");

  const pdir = projectDir(slug);
  for (const [type, actor] of [
    ["plan.compiled", "director"],
    ["construct.created", "human"],
    ["instrument.compiled", "human"],
    ["plan.approved", "human"],
  ]) {
    const ev = await ledger.query(pdir, { type });
    assert.equal(ev.length, 1, `expected exactly one ${type}`);
    assert.equal(ev[0].actor, actor, `${type} actor convention`);
  }

  // run preflight over the materialized instrument
  Object.assign(project, fresh);
  const run = await createRun(project, { instrumentId: inst.id, corpusId });
  assert.equal(typeof run.cost.estUSD, "number");
  assert.deepEqual(run.checkpoint, { done: 0, total: 60 });
  const pf = await ledger.query(pdir, { type: "run.preflight" });
  assert.equal(pf.length, 1);
  assert.equal(pf[0].payload.units, 60);
  assert.equal((await ledger.verify(pdir)).ok, true);
});

// =============================================================================
// concurrency: two runs in one project — monitor module-level Map, ledger
// tail cache, per-slug project lock all shared
// =============================================================================

test("concurrency: two concurrent executeRuns (judge pool-4 + dictionary) keep monitor states, outputs and the ledger chain intact", async () => {
  const slug = "orch-conc";
  const { project, corpusId, units } = await makeProject({
    slug,
    id: "p_orchconc0000001",
    handler: "dir-conc",
    director: false, // no Director needed — pure F1 concurrency surface
    n: 150,
    textOf: (i) => `Response ${i}: ${i % 3 === 0 ? "the salary is low" : "the chairs are fine"}`.padEnd(70, "."),
  });
  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);

  const construct = payConstruct("c_conc");
  const judgeInst = createInstrument({
    id: "inst_judge", constructId: "c_conc", kind: "judge", name: "judge",
    payload: {
      provider: "mock", model: "mock-1", snapshot: "mock-1",
      params: { temperature: 0, maxTokens: 64 },
      promptTemplate: "T {{definition}} {{criteria}} {{examples}} {{unit}}",
      schema: { type: "binary", options: ["yes", "no"] },
      rationaleFirst: true, workerClass: "frontier",
    },
  });
  const dictInst = createInstrument({
    id: "inst_dict", constructId: "c_conc", kind: "dictionary", name: "dict",
    payload: {
      categories: [{ name: "pay", terms: [{ term: "salary" }] }],
      negation: { enabled: false, window: 3 },
      scoring: "count",
    },
  });
  Object.assign(project, await updateProject(slug, (p) => {
    p.constructs.push(construct);
    p.instruments.push(judgeInst, dictInst);
  }));

  const r1 = await createRun(project, { instrumentId: "inst_judge", corpusId });
  const r2 = await createRun(project, { instrumentId: "inst_dict", corpusId });
  let s1 = null;
  let s2 = null;
  const [d1, d2] = await Promise.all([
    executeRun(slug, r1.id, { onTick: (s) => { s1 = s; } }),
    executeRun(slug, r2.id, { onTick: (s) => { s2 = s; } }),
  ]);
  assert.equal(d1.status, "complete");
  assert.equal(d2.status, "complete");

  // monitor: independent per-run states out of one module-level Map (final
  // tick per run), each cleared independently when its run completes
  assert.deepEqual([s1.done, s1.total], [150, 150]);
  assert.deepEqual([s2.done, s2.total], [150, 150]);
  assert.deepEqual(s1.labelDist, { yes: 50, no: 100 });
  assert.deepEqual(s2.labelDist, { yes: 50, no: 100 }, "dictionary instrument agrees with the planted theme");
  assert.equal(monitor.runState(r1.id), null, "complete run r1 cleared its monitor state");
  assert.equal(monitor.runState(r2.id), null, "complete run r2 cleared its monitor state");

  // outputs: complete + exactly-once per run, dictionary labels correct
  const pdir = projectDir(slug);
  const l1 = await readNdjson(path.join(pdir, "runs", r1.id, "outputs.ndjson"));
  const l2 = await readNdjson(path.join(pdir, "runs", r2.id, "outputs.ndjson"));
  assert.equal(l1.length, 150);
  assert.equal(l2.length, 150);
  assertExactlyOnce(l1);
  assertExactlyOnce(l2);
  const byId = new Map(units.map((u) => [u.id, u]));
  for (const l of l2) assert.equal(l.label, ORACLE(byId.get(l.unitId).text));

  // interleaved appends from two runs still verify as one hash chain
  assert.equal((await ledger.verify(pdir)).ok, true);
  const fresh = await loadProject(slug);
  assert.deepEqual(
    fresh.runs.map((r) => r.status).sort(),
    ["complete", "complete"],
    "interleaved persistRun checkpoints did not clobber each other",
  );
});

// =============================================================================
// BUG-2 regression: the drift tripwire's re-judge honors the run's bundle dir
// =============================================================================

test("BUG-2 regression: the drift re-judge uses the run's bundle dir (armDriftTripwire {dir} → driftTick → runEphemeral), not the default projects dir", async (t) => {
  const slug = "orch-driftdir";
  const bundleDir = await mkdtemp(path.join(os.tmpdir(), "concord-orch-bundle-"));
  t.after(() => rm(bundleDir, { recursive: true, force: true }).catch(() => {}));
  t.after(() => rm(path.join(tmpRoot, slug), { recursive: true, force: true }).catch(() => {}));

  // bundle lives in an EXPLICIT dir (executeRun supports {dir} for exactly this)
  const project = createProject({ id: "p_orchdrift00001", name: slug, slug, privacyMode: "open" });
  const construct = payConstruct("c_drift");
  const inst = createInstrument({
    id: "inst_drift", constructId: "c_drift", kind: "judge", name: "j",
    payload: {
      provider: "mock", model: "mock-1", snapshot: "mock-1",
      params: { temperature: 0, maxTokens: 64 },
      promptTemplate: "T {{definition}} {{criteria}} {{examples}} {{unit}}",
      schema: { type: "binary", options: ["yes", "no"] },
      rationaleFirst: true, workerClass: "frontier",
    },
  });
  project.corpora.push({ id: "c1", name: "c" });
  project.constructs.push(construct);
  project.instruments.push(inst);
  await saveProject(project, bundleDir);
  const units = Array.from({ length: 30 }, (_, i) => ({
    id: `u_${String(i).padStart(4, "0")}`,
    text: `r ${i} ${i % 3 === 0 ? "salary" : "chairs"}`.padEnd(40, "."),
    meta: {}, pos: { row: i },
  }));
  const ufile = path.join(bundleDir, slug, "corpora", "c1", "units.ndjson");
  await mkdir(path.dirname(ufile), { recursive: true });
  await writeFile(ufile, units.map((u) => JSON.stringify(u)).join("\n") + "\n", "utf8");

  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);
  const run = await createRun(project, { instrumentId: "inst_drift", corpusId: "c1" }, { dir: bundleDir });
  monitor.armDriftTripwire(run.id, {
    project,
    goldOutputs: units.slice(0, 5).map((u) => ({ unit: u, label: ORACLE(u.text) })),
    instrument: inst,
    every: 10,
    threshold: 0.15,
    baseline: 1.0,
    dir: bundleDir, // the fix under test: the tripwire forwards the run's bundle dir to its re-judge
  });
  t.after(() => monitor.clearRun(run.id));
  const done = await executeRun(slug, run.id, { dir: bundleDir });
  assert.equal(done.status, "complete");

  // The re-judge ran (driftTick crossings at every = 10 over 30 units are
  // awaited inside the unit loop) and cached under the BUNDLE: the run itself
  // caches exactly one entry per unit; each drift re-judge adds entries in its
  // own drift:<runId>:<done> seed namespace, so the bundle cache must hold
  // strictly more entries than the run alone wrote.
  const bundleCache = path.join(bundleDir, slug, "cache");
  assert.ok(existsSync(bundleCache), "the run's cache lives in the bundle");
  const cacheFiles = (await readdir(bundleCache, { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
  assert.ok(
    cacheFiles.length > units.length,
    `drift re-judge cache entries must land in the bundle cache (found ${cacheFiles.length}; the run alone writes ${units.length})`,
  );

  // ...and NOTHING lands under the default projects dir (the original defect:
  // driftTick called runEphemeral without {dir}, polluting projectsDir() —
  // the same defect left <repo>/projects/runs-test/cache behind after the
  // F1 unit suite).
  const strayCache = path.join(tmpRoot, slug, "cache");
  assert.ok(
    !existsSync(strayCache),
    `drift re-judge wrote its cache to the DEFAULT projects dir (${strayCache}) instead of the run's bundle dir — ` +
    "armDriftTripwire/driftTick must accept and forward the dir the engine was given",
  );
});
