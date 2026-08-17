// Per-instrument bootstrap CI on the gold-set agreement route.
//
// The Calibration Test pane's forest plot needs an interval per instrument,
// not just a point. The /agreement handler already attaches a percentile
// bootstrap CI to humanAgreement (gold-integrity.test.js pins that); this
// suite pins the ADDITIVE companion: each perInstrument[].agreement carries a
// `ci {lo, hi, method}` over its own machine-vs-gold rows, bootstrapped with
// the SAME estimator the pane headlines (κ for nominal, linear-weighted κ for
// ordinal) and reusing boot.js bootstrapCI exactly as the human row does.
//
// Invariants pinned here:
//   1. SHAPE — every non-error perInstrument entry has agreement.ci with a
//      numeric lo ≤ hi and method "bootstrap-percentile".
//   2. COVERAGE — lo ≤ the headline stat ≤ hi (κ here; the percentile
//      interval always brackets the point estimate of the full sample only
//      approximately, so we assert containment within a small tolerance).
//   3. ADDITIVE — humanAgreement.ci is untouched; error entries gain no ci.
//   4. ORDINAL — an ordinal construct's instrument CI brackets κw (linear),
//      i.e. the SAME weighted statistic the pane reports, not nominal κ.
//
// Harness mirrors tests/server/alt-judge.test.js: real server on an ephemeral
// port over temp CONCORD_PROJECTS_DIR/CONCORD_CONFIG_DIR, MockModel with a
// deterministic oracle. Tests run serially in declaration order, share via S.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startServer } from "../../server/index.js";
import { getAdapter } from "../../server/providers/registry.js";
import { projectDir } from "../../server/core/store.js";

// ---------------------------------------------------------------- harness

let tmpProjects;
let tmpConfig;
let srv;
let base;

// the worker oracle: "salary" → yes, else no (accuracy 1.0 → machine == oracle)
const ORACLE = (text) => (String(text).includes("salary") ? "yes" : "no");

before(async () => {
  tmpProjects = await mkdtemp(path.join(os.tmpdir(), "concord-agci-"));
  tmpConfig = await mkdtemp(path.join(os.tmpdir(), "concord-agci-cfg-"));
  process.env.CONCORD_PROJECTS_DIR = tmpProjects;
  process.env.CONCORD_CONFIG_DIR = tmpConfig;
  srv = await startServer({ port: 0 });
  base = `http://127.0.0.1:${srv.port}`;
  for (const name of ["openrouter", "ollama"]) {
    const { adapter } = getAdapter({ privacyMode: "open" }, name);
    adapter.catalog = async () => [];
  }
  const mock = getAdapter({ privacyMode: "open" }, "mock").adapter;
  mock.setAccuracy(1.0);
  mock.setOracle(ORACLE);
});

after(async () => {
  await srv.close();
  delete process.env.CONCORD_PROJECTS_DIR;
  delete process.env.CONCORD_CONFIG_DIR;
  await rm(tmpProjects, { recursive: true, force: true }).catch(() => {});
  await rm(tmpConfig, { recursive: true, force: true }).catch(() => {});
});

// ------------------------------------------------------------ HTTP helpers

async function call(method, p, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + p, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text };
}

async function ok(method, p, body) {
  const r = await call(method, p, body);
  assert.equal(r.status, 200, `${method} ${p} → ${r.status}: ${r.text?.slice(0, 300)}`);
  assert.equal(r.json?.ok, true, `${method} ${p} envelope not ok`);
  return r.json.data;
}

async function upload(p, filename, content) {
  const form = new FormData();
  form.append("file", new Blob([content]), filename);
  const res = await fetch(base + p, { method: "POST", body: form });
  const json = JSON.parse(await res.text());
  assert.equal(
    res.status,
    200,
    `upload ${p} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`,
  );
  assert.equal(json.ok, true);
  return json.data;
}

// 40 rows, padded to a fixed length so none trips the p99-length escalation;
// the oracle splits yes/no by the "salary" keyword on even rows.
function makeCsv(rows) {
  const lines = ["respondent_id,dept,response"];
  for (let i = 0; i < rows; i++) {
    const text = (
      i % 2 === 0
        ? `the salary is too low for this work and it never improves (${i})`
        : `the office is comfortable and the team is genuinely kind here (${i})`
    ).padEnd(100, ".");
    lines.push(`r${i},${i % 2 ? "sales" : "ops"},${text}`);
  }
  return lines.join("\n") + "\n";
}

const judgePayload = () => ({
  provider: "mock",
  model: "mock-1",
  snapshot: "mock-1",
  params: { temperature: 0, maxTokens: 64 },
  promptTemplate: "Judge the unit. {{definition}} {{criteria}} {{examples}} {{unit}}",
  schema: { type: "binary", options: ["yes", "no"] },
  rationaleFirst: true,
  workerClass: "frontier",
});

// ------------------------------------------------------------ shared state

const S = {
  slug: null,
  corpusId: null,
  binaryId: null,
  ordinalId: null,
  instId: null,
  unitIds: [],
  textById: new Map(),
};

const G = (rest = "") => `/api/projects/${S.slug}/goldsets${rest}`;

// Drive two coders to consensus gold over a set of units. On a fraction of
// units BOTH coders agree on a deliberately wrong label, so machine-vs-gold κ
// lands strictly inside (0,1) — a real interval with spread, never the
// degenerate κ=1 (which would drop every bootstrap replicate and carry no ci).
async function buildGold(constructId, unitIds, labelFor) {
  const gs = await ok("POST", G(), { constructId, corpusId: S.corpusId });
  for (const unitId of unitIds) {
    // queue the exact units we want into the sample (pi: null — agreement
    // reads queued units; only DSL's π-weighted estimators skip them), then
    // drive two coders to a consensus label so the unit becomes gold.
    await ok("POST", G(`/${gs.id}/queue`), { unitId });
    const label = labelFor(unitId);
    for (const coder of ["coder-A", "coder-B"]) {
      await ok("POST", G(`/${gs.id}/label`), { coder, unitId, label });
    }
  }
  return gs;
}

// ---------------------------------------------------------------- the tests

test("setup: project + corpus + binary construct + judge instrument + a complete run", async () => {
  const project = await ok("POST", "/api/projects", { name: "Agreement CI" });
  S.slug = project.slug;

  const up = await upload(`/api/projects/${S.slug}/import`, "survey.csv", makeCsv(40));
  const conf = await ok("POST", `/api/projects/${S.slug}/import/confirm`, {
    importId: up.importId,
    mapping: { textColumn: "response" },
    unitization: { scheme: "response" },
  });
  S.corpusId = conf.corpusId;
  assert.equal(conf.unitCount, 40);

  const lines = (
    await readFile(path.join(projectDir(S.slug), "corpora", S.corpusId, "units.ndjson"), "utf8")
  )
    .split(/\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  S.unitIds = lines.map((u) => u.id);
  S.textById = new Map(lines.map((u) => [u.id, u.text]));

  const binary = await ok("POST", `/api/projects/${S.slug}/constructs`, {
    name: "Pay complaint",
    type: "binary",
    definition: "The unit complains about compensation.",
    categories: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
  });
  S.binaryId = binary.id;

  const inst = await ok("POST", `/api/projects/${S.slug}/instruments`, {
    constructId: S.binaryId,
    kind: "judge",
    name: "Pay judge",
    payload: judgePayload(),
  });
  S.instId = inst.id;
});

// =========================================================================
// 1 + 2 + 3 — the per-instrument CI shape, coverage, and additivity
// =========================================================================

test("agreement: every perInstrument entry carries a bootstrap CI bracketing its κ; humanAgreement.ci untouched", async () => {
  // gold = oracle truth, but flip ~25% of units to a unanimous WRONG label so
  // machine-vs-gold κ is strictly inside (0,1) — a real, spread interval.
  const flip = new Set(S.unitIds.filter((_, i) => i % 4 === 0));
  await buildGold(S.binaryId, S.unitIds, (unitId) => {
    const truth = ORACLE(S.textById.get(unitId));
    if (flip.has(unitId)) return truth === "yes" ? "no" : "yes";
    return truth;
  });

  const r = await ok("GET", G(`/${await firstGoldsetId()}/agreement`));

  // human side keeps its own CI (additive — we did not disturb it)
  assert.ok(r.humanAgreement, "human agreement present");
  assert.ok(r.humanAgreement.ci, "humanAgreement.ci still present");
  assert.equal(r.humanAgreement.ci.method, "bootstrap-percentile");

  const mine = r.perInstrument.find((x) => x.instrumentId === S.instId);
  assert.ok(
    mine,
    `inst in perInstrument: ${JSON.stringify(r.perInstrument.map((x) => x.instrumentId))}`,
  );
  assert.ok(!mine.error, JSON.stringify(mine.error ?? null));

  const a = mine.agreement;
  assert.ok(typeof a.kappa === "number", `κ is a number (got ${a.kappa})`);
  assert.ok(a.kappa > 0 && a.kappa < 1, `κ has spread, strictly inside (0,1) (got ${a.kappa})`);

  // 1. SHAPE
  const ci = a.ci;
  assert.ok(ci, "perInstrument agreement.ci present");
  assert.equal(ci.method, "bootstrap-percentile", "the method names itself");
  assert.ok(typeof ci.lo === "number" && typeof ci.hi === "number", "lo/hi are numbers");
  assert.ok(ci.lo <= ci.hi, `lo ${ci.lo} ≤ hi ${ci.hi}`);

  // 2. COVERAGE — the percentile interval brackets the full-sample κ (allow a
  // hair of tolerance: the point estimate need not equal a sample quantile).
  const tol = 1e-9;
  assert.ok(
    ci.lo <= a.kappa + tol && a.kappa - tol <= ci.hi,
    `lo ${ci.lo} ≤ κ ${a.kappa} ≤ hi ${ci.hi}`,
  );

  // every non-error perInstrument entry follows the same contract
  for (const inst of r.perInstrument) {
    if (inst.error) {
      assert.ok(!inst.agreement?.ci, "error entries gain no ci");
      continue;
    }
    const ag = inst.agreement;
    if (ag.kappa === null || ag.kappa === undefined) continue; // degenerate κ → ci may be absent
    assert.ok(ag.ci, `perInstrument ${inst.instrumentId} carries a ci`);
    assert.equal(ag.ci.method, "bootstrap-percentile");
    assert.ok(ag.ci.lo <= ag.ci.hi, "lo ≤ hi");
    assert.ok(
      ag.ci.lo <= ag.kappa + tol && ag.kappa - tol <= ag.ci.hi,
      `${inst.instrumentId}: lo ≤ κ ≤ hi`,
    );
  }
});

test("agreement: the CI is deterministic across calls (seeded bootstrap)", async () => {
  const gid = await firstGoldsetId();
  const r1 = await ok("GET", G(`/${gid}/agreement`));
  const r2 = await ok("GET", G(`/${gid}/agreement`));
  const ci1 = r1.perInstrument.find((x) => x.instrumentId === S.instId)?.agreement?.ci;
  const ci2 = r2.perInstrument.find((x) => x.instrumentId === S.instId)?.agreement?.ci;
  assert.ok(ci1 && ci2, "both calls carry a ci");
  assert.deepEqual(ci1, ci2, "the seeded bootstrap is reproducible run to run");
});

// =========================================================================
// 4 — ORDINAL: the interval brackets the SAME weighted stat the pane reports
// =========================================================================

test("agreement (ordinal): the per-instrument CI brackets κw (linear), the headline weighted stat", async () => {
  // an ordinal construct on the SAME corpus; the judge labels low/med/high,
  // and gold flips a slice by ONE rank so κw (linear) has spread.
  const ordinal = await ok("POST", `/api/projects/${S.slug}/constructs`, {
    name: "Complaint intensity",
    type: "ordinal",
    definition: "How intense the complaint reads.",
    categories: [
      { value: "low", label: "Low" },
      { value: "med", label: "Medium" },
      { value: "high", label: "High" },
    ],
  });
  S.ordinalId = ordinal.id;

  const ORDER = ["low", "med", "high"];
  // a judge whose oracle maps salary→high else→low (within the declared scale)
  const ordOracle = (text) => (String(text).includes("salary") ? "high" : "low");
  const om = getAdapter({ privacyMode: "open" }, "mock").adapter;
  om.setOracle(ordOracle);

  await ok("POST", `/api/projects/${S.slug}/instruments`, {
    constructId: S.ordinalId,
    kind: "judge",
    name: "Intensity judge",
    payload: {
      ...judgePayload(),
      // ordinal constructs judge through the likert schema (judge.js
      // outputSchemaFor maps construct "ordinal" → schema "likert")
      schema: { type: "likert", options: ORDER },
    },
  });

  // gold: oracle truth, but pull every 3rd unit to the middle rank so the
  // machine (oracle: high/low) disagrees by one rank there — κw (linear) lands
  // strictly < 1, and a nominal κ would score those near-misses differently.
  const units = S.unitIds.slice(0, 30);
  await buildGold(S.ordinalId, units, (unitId) => {
    const truth = ordOracle(S.textById.get(unitId));
    const i = units.indexOf(unitId);
    return i % 3 === 0 ? "med" : truth; // every 3rd unit → one rank off the machine
  });

  // find the ordinal gold set (the most recent one for the ordinal construct)
  const p = await ok("GET", `/api/projects/${S.slug}`);
  const ordGs = [...p.goldsets].reverse().find((g) => g.constructId === S.ordinalId);
  assert.ok(ordGs, "the ordinal gold set registered");

  // the agreement route re-judges gold units ephemerally — keep the ordinal
  // oracle live so the machine emits in-scale (low/med/high) labels, not the
  // binary yes/no the enum would reject.
  const r = await ok("GET", G(`/${ordGs.id}/agreement`));
  om.setOracle(ORACLE); // restore for any later binary machine pass

  const mine = r.perInstrument.find((x) => x.name === "Intensity judge");
  assert.ok(mine, `intensity judge present: ${JSON.stringify(r.perInstrument.map((x) => x.name))}`);
  assert.ok(!mine.error, JSON.stringify(mine.error ?? null));

  const a = mine.agreement;
  assert.ok(typeof a.kappa === "number", "weighted κ is a number");
  const ci = a.ci;
  assert.ok(ci, "ordinal per-instrument ci present");
  assert.equal(ci.method, "bootstrap-percentile");
  const tol = 1e-9;
  assert.ok(
    ci.lo <= a.kappa + tol && a.kappa - tol <= ci.hi,
    `the interval brackets the weighted κ the pane headlines: lo ${ci.lo} ≤ κw ${a.kappa} ≤ hi ${ci.hi}`,
  );
});

// the gold set the binary tests share (first one created on this project)
async function firstGoldsetId() {
  const p = await ok("GET", `/api/projects/${S.slug}`);
  const gs = p.goldsets.find((g) => g.constructId === S.binaryId);
  assert.ok(gs, "binary gold set present");
  return gs.id;
}
