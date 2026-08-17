// Reporting honesty — pins the REPORTING/SETTINGS accuracy-sweep fixes:
//
//   replication scripts: binarize per cell with the recorded positive value
//     (string labels), per-cell handling for descriptive corrected analyses,
//     empty-label filtering (panel flagged aggregates), hand-queued gold rows
//     (pi withheld) excluded, honest coverage statement when corrected
//     regression analyses cannot be refit by the generated code, and the
//     unbiasedness line suppressed for uncertainty-targeted gold designs;
//   methods prose: every conditional-honesty reword (snapshot recording vs
//     verification, seed transmission per provider, escalation with/without a
//     Director, live-construct disclosure, uncertainty-design π, ordinal
//     weighted κ, hand-queued gold counts, structured-output quarantine,
//     consensus gold standard, per-cell naive companion, estimate-grade cost,
//     silver-tuning order proof);
//   routes: GET exports/methods/preview is side-effect-free while the export
//     of record still ledgers; ?goldText=0 strips unit text from the gold CSV.
//
// NOTE: the generated R/python is verified by TEXT assertions plus a JS
// re-implementation of the scripts' estimator semantics over the archive
// CSVs (Rscript/python are not assumed installed on this machine).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";

import { appendNdjson, updateProject, projectDir as pdir } from "../../server/core/store.js";
import * as ledger from "../../server/core/ledger.js";
import { dslProportion, dslDiff, dslOLS, dslLogit } from "../../server/stats/correction.js";
import * as methods from "../../server/reporting/methods.js";
import * as replication from "../../server/reporting/replication.js";

// ============================================================ part A fixture
// A real on-disk bundle (units, runs, ledger) plus an in-memory project whose
// goldsets/analyses ride the loadGoldset/loadAnalysis object-graph fallback,
// so tests can structuredClone-and-mutate without touching disk.

const A = {};

async function buildFixtureA() {
  const root = await mkdtemp(path.join(os.tmpdir(), "concord-honesty-"));
  const dir = path.join(root, "honesty-fixture");
  await mkdir(dir, { recursive: true });

  const corpusId = "corp_h";
  const ids = ["u0", "u1", "u2", "u3", "u4", "u5", "u6", "u7"];
  const depts = ["sales", "sales", "sales", "sales", "ops", "ops", "ops", "ops"];
  // numeric covariate for the corrected-regression analyses (an_model/an_ols);
  // values chosen so the DSL logit estimating equation converges on this tiny n
  const sats = [3, 2, 4, 2, 1, 5, 3, 4];
  const texts = ids.map((id, i) => `Unit ${id} about pay and ${depts[i]} work.`);
  for (let i = 0; i < ids.length; i++) {
    await appendNdjson(path.join(dir, "corpora", corpusId, "units.ndjson"), {
      id: ids[i],
      text: texts[i],
      meta: { dept: depts[i], satisfaction: sats[i] },
    });
  }

  // STRING machine labels; u7's aggregate is flagged (no consensus, NO label)
  const agg = { u0: "yes", u1: "yes", u2: "no", u3: "yes", u4: "no", u5: "no", u6: "yes" };
  const jurorA = {
    u0: "yes",
    u1: "yes",
    u2: "no",
    u3: "yes",
    u4: "no",
    u5: "no",
    u6: "yes",
    u7: "yes",
  };
  const jurorB = {
    u0: "yes",
    u1: "yes",
    u2: "no",
    u3: "yes",
    u4: "no",
    u5: "no",
    u6: "yes",
    u7: "no",
  };

  const runH = {
    id: "run_h",
    instrumentId: "inst_h",
    corpusId,
    status: "complete",
    checkpoint: { done: 8, total: 8 },
    cost: { estUSD: 0.06, actualUSD: 0.05, inputTokens: 4000, outputTokens: 1200 },
    escalation: { count: 2, directorModel: "director-9000" },
    quarantine: ["u_q1"],
    provider: "anthropic",
    model: "claude-panel",
    snapshot: "claude-judge-a-20260101",
    pinned: true,
    startedAt: "2026-06-02T10:00:00.000Z",
    finishedAt: "2026-06-02T10:05:00.000Z",
  };
  await mkdir(path.join(dir, "runs", runH.id), { recursive: true });
  await writeFile(
    path.join(dir, "runs", runH.id, "run.json"),
    JSON.stringify(runH, null, 2),
    "utf8",
  );
  for (const u of ids) {
    await appendNdjson(path.join(dir, "runs", runH.id, "outputs.ndjson"), {
      unitId: u,
      juror: "j_a",
      label: jurorA[u],
      confidence: 0.8,
    });
    await appendNdjson(path.join(dir, "runs", runH.id, "outputs.ndjson"), {
      unitId: u,
      juror: "j_b",
      label: jurorB[u],
      confidence: 0.7,
    });
    if (agg[u] !== undefined) {
      await appendNdjson(path.join(dir, "runs", runH.id, "outputs.ndjson"), {
        unitId: u,
        juror: "aggregate",
        label: agg[u],
      });
    } else {
      await appendNdjson(path.join(dir, "runs", runH.id, "outputs.ndjson"), {
        unitId: u,
        juror: "aggregate",
        flagged: true,
        entropy: 0.92,
      });
    }
  }

  // a second run whose escalations had NO Director configured
  const runH2 = {
    ...runH,
    id: "run_h2",
    escalation: { count: 1, directorModel: null },
    quarantine: [],
  };
  await mkdir(path.join(dir, "runs", runH2.id), { recursive: true });
  await writeFile(
    path.join(dir, "runs", runH2.id, "run.json"),
    JSON.stringify(runH2, null, 2),
    "utf8",
  );

  // gold: 4 design rows (pi 0.5) + ONE hand-queued row (pi null) that carries
  // an adjudicated label and must stay OUT of every corrected estimator
  const pi = 0.5;
  const ADJ = { u0: "yes", u2: "no", u4: "no", u6: "no", u1: "yes" };
  const goldDesignIds = ["u0", "u2", "u4", "u6"];
  const gsGold = {
    id: "gs_h",
    constructId: "c_h",
    tier: "gold",
    design: "srs",
    status: "complete",
    sample: [
      ...goldDesignIds.map((unitId) => ({ unitId, pi })),
      { unitId: "u1", pi: null, queued: true },
    ],
    coders: [
      { coderId: "a", blind: true, labels: { u0: "yes", u2: "no", u4: "no", u6: "no", u1: "yes" } },
      {
        coderId: "b",
        blind: true,
        labels: { u0: "yes", u2: "no", u4: "yes", u6: "no", u1: "yes" },
      },
    ],
    adjudicated: ADJ,
    humanAgreement: {
      n: 4,
      percent: 0.75,
      kappa: 0.5,
      alpha: 0.45,
      ci: { lo: 0.1, hi: 0.8, method: "bootstrap" },
    },
  };
  const gsSilver = {
    id: "gs_s",
    constructId: "c_h",
    tier: "silver",
    design: "srs",
    status: "complete",
    sample: [{ unitId: "u3", pi: 1 / 8 }],
    coders: [{ coderId: "director", blind: true, labels: { u3: "yes" } }],
  };

  const construct = {
    id: "c_h",
    name: "Pay concern",
    type: "binary",
    definition: "Mentions of pay as a stated concern.",
    criteria: { include: ["pay complaints"], exclude: ["benefits-only complaints"] },
    edgeCases: [],
    examples: [],
    categories: [{ value: "yes" }, { value: "no" }],
    authoredBy: "human",
    humanTouched: true,
  };

  const instrument = {
    id: "inst_h",
    constructId: "c_h",
    kind: "panel",
    name: "Pay panel",
    level: "calibrated",
    version: 1,
    versionHash: "abcdef0123456789abcdef0123456789",
    frozen: true,
    payload: {
      jurors: [
        {
          provider: "anthropic",
          model: "claude-judge-a",
          snapshot: "claude-judge-a-20260101",
          params: { temperature: 0, maxTokens: 256, seed: 11 },
        },
        {
          provider: "anthropic",
          model: "claude-judge-b",
          snapshot: "claude-judge-b-20260101",
          params: { temperature: 0, maxTokens: 256, seed: 11 },
        },
      ],
      aggregation: "majority",
      promptTemplate:
        "Coder.\n{{definition}}\n{{criteria}}\n{{examples}}\nUnit:\n{{unit}}\nReturn JSON.",
      schema: { type: "binary" },
    },
    silver: { goldsetId: "gs_s", iterations: [{ agreement: 0.8 }, { agreement: 0.9 }] },
    certificate: {
      frozenAt: "2026-06-01T12:00:00.000Z",
      goldsetId: "gs_h",
      agreement: { n: 4, percent: 0.75, kappa: 0.5, alpha: 0.45 },
      humanAgreement: gsGold.humanAgreement,
      versionHash: "abcdef0123456789abcdef0123456789",
      modelPinned: true,
    },
    authoredBy: "human",
  };

  // expected corrected numbers from the REAL estimator (string labels binarized)
  const yes = (l) => (l === "yes" ? 1 : 0);
  const goldPi = new Set(goldDesignIds);
  const labeled = ids.filter((u) => agg[u] !== undefined); // u0..u6
  const mkUnits = (unitIds, positive) =>
    unitIds.map((u) => {
      const row = { yhat: agg[u] === positive ? 1 : 0 };
      if (goldPi.has(u)) {
        row.y = ADJ[u] === positive ? 1 : 0;
        row.pi = pi;
      }
      return row;
    });
  const salesIds = labeled.filter((u) => depts[ids.indexOf(u)] === "sales");
  const opsIds = labeled.filter((u) => depts[ids.indexOf(u)] === "ops");
  const ops = dslProportion(mkUnits(opsIds, "yes"));
  const sales = dslProportion(mkUnits(salesIds, "yes"));
  const diff = dslDiff(mkUnits(opsIds, "yes"), mkUnits(salesIds, "yes"));
  const cellYes = dslProportion(mkUnits(labeled, "yes"));
  const cellNo = dslProportion(mkUnits(labeled, "no"));
  void yes;

  // real corrected REGRESSION fits (same data path computeModel walks):
  // usable rows = labeled units with numeric satisfaction; gold rows carry
  // y + pi. The stored results below are what Concord actually computed, so
  // the generated refit scripts must reproduce them from the archive CSVs.
  const mkModelUnits = (positive) =>
    labeled.map((u) => {
      const row = { yhat: agg[u] === positive ? 1 : 0, x: [sats[ids.indexOf(u)]] };
      if (goldPi.has(u)) {
        row.y = ADJ[u] === positive ? 1 : 0;
        row.pi = pi;
      }
      return row;
    });
  const modelNames = ["(Intercept)", "satisfaction"];
  const renameCoef = (coef) => coef.map((c, i) => ({ ...c, name: modelNames[i] ?? c.name }));
  const logitFit = dslLogit(mkModelUnits("yes"), 1);
  const olsFit = dslOLS(mkModelUnits("yes"), 1);

  const cellOf = (group, n, r) => ({
    group,
    n,
    est: r.est,
    se: r.se,
    ciLo: r.ciLo,
    ciHi: r.ciHi,
    naive: r.naive,
  });
  const anPos = {
    id: "an_pos",
    kind: "crosstab",
    spec: {
      instrumentId: "inst_h",
      runId: "run_h",
      corpusId,
      goldsetId: "gs_h",
      rowKey: "label",
      colKey: "dept",
    },
    results: {
      estimator: "dslProportion",
      outcome: 'share of "yes"',
      groupBy: "dept",
      positive: "yes",
      cells: [cellOf("ops", opsIds.length, ops), cellOf("sales", salesIds.length, sales)],
      diff: {
        a: "ops",
        b: "sales",
        est: diff.est,
        se: diff.se,
        ciLo: diff.ciLo,
        ciHi: diff.ciHi,
        naive: diff.naive,
      },
    },
    level: "corrected",
    createdAt: "2026-06-02T11:00:00.000Z",
  };
  const anDesc = {
    id: "an_desc",
    kind: "descriptive",
    spec: { instrumentId: "inst_h", runId: "run_h", corpusId, goldsetId: "gs_h" },
    results: {
      estimator: "dslProportion",
      outcome: "label",
      groupBy: null,
      cells: [cellOf("yes", 4, cellYes), cellOf("no", 3, cellNo)],
    },
    level: "corrected",
    createdAt: "2026-06-02T11:10:00.000Z",
  };
  const anModel = {
    id: "an_model",
    kind: "model",
    spec: {
      instrumentId: "inst_h",
      runId: "run_h",
      corpusId,
      goldsetId: "gs_h",
      x: ["satisfaction"],
      family: "logit",
    },
    results: {
      estimator: "dslLogit",
      family: "logit",
      outcome: 'machine label == "yes"',
      coef: renameCoef(logitFit.coef),
      naive: renameCoef(logitFit.naive),
      n: 7,
      nGold: 4,
    },
    level: "corrected",
    createdAt: "2026-06-02T11:20:00.000Z",
  };
  const anOls = {
    id: "an_ols",
    kind: "model",
    spec: {
      instrumentId: "inst_h",
      runId: "run_h",
      corpusId,
      goldsetId: "gs_h",
      x: ["satisfaction"],
      family: "linear",
    },
    results: {
      estimator: "dslOLS",
      family: "linear",
      outcome: 'machine label == "yes"',
      coef: renameCoef(olsFit.coef),
      naive: renameCoef(olsFit.naive),
      n: 7,
      nGold: 4,
    },
    level: "corrected",
    createdAt: "2026-06-02T11:25:00.000Z",
  };
  const anNull = {
    ...structuredClone(anPos),
    id: "an_null",
    spec: { ...anPos.spec, runId: "run_h2" },
  };

  const project = {
    id: "p_h",
    name: "Honesty Fixture",
    slug: "honesty-fixture",
    createdAt: "2026-06-01T08:00:00.000Z",
    privacyMode: "open",
    corpora: [
      {
        id: corpusId,
        name: "Survey",
        source: { filename: "s.csv", format: "csv", rows: 8 },
        unitization: { scheme: "response" },
        unitCount: 8,
      },
    ],
    constructs: [construct],
    instruments: [instrument],
    goldsets: [gsGold, gsSilver],
    analyses: [anPos, anDesc, anModel, anOls, anNull],
  };

  // ledger: silver tuning BEFORE any human gold label (order provable)
  const ev = (actor, type, refs, payload = {}) => ledger.append(dir, actor, type, refs, payload);
  await ev("system", "project.created", { projectId: "p_h" }, { name: project.name });
  await ev(
    "human",
    "corpus.imported",
    { projectId: "p_h", corpusId },
    { filename: "s.csv", format: "csv", rows: 8 },
  );
  await ev("system", "corpus.unitized", { corpusId }, { scheme: "response", unitCount: 8 });
  await ev(
    "human",
    "construct.created",
    { constructId: "c_h" },
    { name: construct.name, type: construct.type },
  );
  await ev("human", "instrument.created", { instrumentId: "inst_h" }, { kind: "panel" });
  await ev(
    "director",
    "instrument.compiled",
    { instrumentId: "inst_h" },
    { versionHash: instrument.versionHash },
  );
  await ev(
    "director",
    "instrument.silver_tuned",
    { instrumentId: "inst_h", goldsetId: "gs_s" },
    { iterations: 2, finalAgreement: 0.9 },
  );
  await ev("human", "goldset.created", { goldsetId: "gs_h" }, { tier: "gold" });
  await ev("system", "goldset.sampled", { goldsetId: "gs_h" }, { design: "srs", n: 4 });
  await ev("human", "goldset.label", { goldsetId: "gs_h", unitId: "u0" }, { coder: "a" });
  await ev("human", "goldset.label", { goldsetId: "gs_h", unitId: "u0" }, { coder: "b" });
  await ev("system", "goldset.agreement", { goldsetId: "gs_h" }, { n: 4 });
  await ev("human", "goldset.adjudicated", { goldsetId: "gs_h" }, { n: 5 });
  await ev(
    "human",
    "instrument.frozen",
    { instrumentId: "inst_h", goldsetId: "gs_h" },
    { versionHash: instrument.versionHash },
  );
  await ev("human", "run.started", { runId: "run_h", instrumentId: "inst_h", corpusId }, {});
  await ev("system", "run.completed", { runId: "run_h" }, { done: 8, total: 8 });
  await ev("human", "run.started", { runId: "run_h2", instrumentId: "inst_h", corpusId }, {});
  await ev("system", "run.completed", { runId: "run_h2" }, { done: 8, total: 8 });
  await ev(
    "system",
    "analysis.created",
    { analysisId: "an_pos", runId: "run_h" },
    { kind: "crosstab", estimator: "dslProportion", level: "corrected" },
  );
  await ev(
    "system",
    "analysis.created",
    { analysisId: "an_desc", runId: "run_h" },
    { kind: "descriptive", estimator: "dslProportion", level: "corrected" },
  );
  await ev(
    "system",
    "analysis.created",
    { analysisId: "an_model", runId: "run_h" },
    { kind: "model", estimator: "dslLogit", level: "corrected" },
  );
  await ev(
    "system",
    "analysis.created",
    { analysisId: "an_ols", runId: "run_h" },
    { kind: "model", estimator: "dslOLS", level: "corrected" },
  );

  Object.assign(A, {
    root,
    dir,
    project,
    ids,
    agg,
    ADJ,
    goldPi,
    pi,
    depts,
    sats,
    expected: {
      ops,
      sales,
      diff,
      cellYes,
      cellNo,
      logit: anModel.results.coef,
      olsCoef: anOls.results.coef,
    },
  });
}

await buildFixtureA();
after(() => rm(A.root, { recursive: true, force: true }).catch(() => {}));

const gen = (project, analysisId) =>
  methods.generate(project ?? A.project, analysisId ?? "an_pos", { projectDir: A.dir });
const buildZip = async (project, analysisIds, opts = {}) => {
  const { zipBuffer } = await replication.build(project ?? A.project, analysisIds, {
    projectDir: A.dir,
    ...opts,
  });
  return unzipSync(new Uint8Array(zipBuffer));
};

// tiny CSV reader for members known to be quote-free (gold built without text)
function csvRows(text) {
  const [header, ...lines] = text
    .trim()
    .split("\n")
    .map((l) => l.split(","));
  return lines.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i]])));
}

// =================================================== replication: the scripts

test("scripts binarize with the recorded positive value and filter empty-label rows", async () => {
  const files = await buildZip(null, ["an_pos"], { includeGoldText: false });
  const r = strFromU8(files["reproduce.R"]);
  const py = strFromU8(files["reproduce.py"]);

  // R: recorded positive value present and used to binarize machine + gold labels
  assert.ok(r.includes('positive <- "yes"'), "R must embed the recorded positive value");
  assert.ok(
    r.includes("d$yhat <- as.integer(as.character(d$label) == positive)"),
    "R must binarize the machine label",
  );
  assert.ok(r.includes("gold_lab[on_gold] == positive"), "R must binarize the gold label");
  // R: empty-label rows (panel flagged aggregates) filtered before the merge
  assert.ok(
    r.includes('outputs <- subset(outputs, !is.na(label) & label != "")'),
    "R empty-label filter missing",
  );
  // R: gold rows require BOTH a recorded label and a recorded pi (queued rows out)
  assert.ok(
    r.includes('on_gold <- !is.na(d$pi) & !is.na(gold_lab) & gold_lab != ""'),
    "R gold-row mask missing",
  );
  // the old unbinarized assignment is gone
  assert.ok(!/_pred <- d\$label/.test(r), "raw label must not feed the pseudo-outcome");

  // python: same contract
  assert.ok(py.includes('positive = "yes"'), "py must embed the recorded positive value");
  assert.ok(
    py.includes('(label_text(d["label"]) == positive).astype(float)'),
    "py must binarize the machine label",
  );
  assert.ok(
    py.includes('label_text(d["adjudicated"]) == positive'),
    "py must binarize the gold label",
  );
  assert.ok(
    py.includes(
      'outputs = outputs[outputs["label"].notna() & (label_text(outputs["label"]) != "")]',
    ),
    "py empty-label filter missing",
  );
  assert.ok(
    py.includes('d["adjudicated"].notna() & d["pi"].notna()'),
    "py gold-row mask (label AND pi) missing",
  );

  // panel aggregate filter is still there, verbatim
  assert.ok(
    r.includes('if ("juror" %in% names(outputs)) outputs <- subset(outputs, juror == "aggregate")'),
  );
  assert.ok(py.includes('outputs = outputs[outputs["juror"] == "aggregate"]'));

  // stored numbers still embedded at full precision
  for (const x of [
    A.expected.ops.est,
    A.expected.ops.se,
    A.expected.sales.est,
    A.expected.sales.se,
  ]) {
    assert.ok(py.includes(String(x)), `stored number ${x} missing from reproduce.py`);
    assert.ok(r.includes(String(x)), `stored number ${x} missing from reproduce.R`);
  }
});

test("descriptive corrected analyses get per-cell binarization, not one pooled estimate", async () => {
  const files = await buildZip(null, ["an_desc"], { includeGoldText: false });
  const r = strFromU8(files["reproduce.R"]);
  const py = strFromU8(files["reproduce.py"]);

  // R: each cell binarizes against its OWN label value
  assert.ok(
    r.includes('as.integer(as.character(d$label) == "yes")'),
    "R per-cell binarization for 'yes' missing",
  );
  assert.ok(
    r.includes('as.integer(as.character(d$label) == "no")'),
    "R per-cell binarization for 'no' missing",
  );
  // each cell asserts its own estimate (two distinct stopifnot targets)
  assert.ok(
    r.includes(String(A.expected.cellYes.est)) && r.includes(String(A.expected.cellNo.est)),
    "both per-cell estimates must be asserted",
  );
  assert.notEqual(
    A.expected.cellYes.est,
    A.expected.cellNo.est,
    "fixture must distinguish the cells",
  );

  // python: per-cell binarization inside the cells loop
  assert.ok(
    py.includes('(label_text(d["label"]) == group).astype(float)'),
    "py per-cell binarization missing",
  );
  assert.ok(
    py.includes(String(A.expected.cellYes.est)) && py.includes(String(A.expected.cellNo.est)),
  );
});

test("a JS replica of the generated script logic reproduces the stored numbers from the CSVs", async () => {
  const files = await buildZip(null, ["an_pos", "an_desc"], { includeGoldText: false });
  const outRows = csvRows(strFromU8(files["outputs/run_h.csv"]))
    .filter((row) => row.juror === "aggregate")
    .filter((row) => row.label !== "");
  assert.equal(outRows.length, 7, "flagged aggregate (no label) must drop, leaving 7 rows");
  const unitById = new Map(csvRows(strFromU8(files["units/corp_h.csv"])).map((u) => [u.unitId, u]));
  const goldById = new Map(csvRows(strFromU8(files["gold/gs_h.csv"])).map((g) => [g.unitId, g]));

  const dsl = (rows, positive, dept) => {
    const pseudo = [];
    for (const row of rows) {
      if (dept && unitById.get(row.unitId)?.meta_dept !== dept) continue;
      const yhat = row.label === positive ? 1 : 0;
      const g = goldById.get(row.unitId);
      const onGold = g && g.adjudicated !== "" && g.pi !== "";
      pseudo.push(
        onGold ? yhat + ((g.adjudicated === positive ? 1 : 0) - yhat) / Number(g.pi) : yhat,
      );
    }
    const n = pseudo.length;
    const est = pseudo.reduce((a, b) => a + b, 0) / n;
    const se = Math.sqrt(pseudo.reduce((a, v) => a + (v - est) ** 2, 0) / n / n);
    return { est, se, n };
  };

  // crosstab cells (single positive, grouped)
  for (const [dept, want] of [
    ["ops", A.expected.ops],
    ["sales", A.expected.sales],
  ]) {
    const got = dsl(outRows, "yes", dept);
    assert.ok(Math.abs(got.est - want.est) < 1e-12, `${dept} est: ${got.est} != ${want.est}`);
    assert.ok(Math.abs(got.se - want.se) < 1e-12, `${dept} se: ${got.se} != ${want.se}`);
  }
  // descriptive cells (per-cell positive, pooled rows)
  for (const [label, want] of [
    ["yes", A.expected.cellYes],
    ["no", A.expected.cellNo],
  ]) {
    const got = dsl(outRows, label, null);
    assert.equal(got.n, 7, "descriptive cells pool every labeled unit");
    assert.ok(Math.abs(got.est - want.est) < 1e-12, `cell ${label} est: ${got.est} != ${want.est}`);
    assert.ok(Math.abs(got.se - want.se) < 1e-12, `cell ${label} se: ${got.se} != ${want.se}`);
  }
  // the queued gold row (pi empty) is in the CSV but NOT a gold row
  assert.equal(goldById.get("u1").pi, "", "queued row ships with empty pi");
});

// Strongest check available: when a python with numpy+pandas exists on this
// machine, EXECUTE the generated reproduce.py against the extracted archive —
// its own asserts re-derive every stored number to 1e-6. Skipped (not failed)
// where python/numpy are absent; R execution is not attempted (no Rscript
// assumed), R is covered by the text assertions + the JS replica above.
function pythonWithPandas() {
  for (const exe of ["python", "python3"]) {
    try {
      const probe = spawnSync(exe, ["-c", "import numpy, pandas"], {
        encoding: "utf8",
        timeout: 30000,
      });
      if (probe.status === 0) return exe;
    } catch {
      /* not installed under this name */
    }
  }
  return null;
}
const PYTHON = pythonWithPandas();

test(
  "the generated reproduce.py EXECUTES end-to-end against the archive — proportions AND corrected regressions",
  { skip: PYTHON ? false : "python with numpy+pandas not available" },
  async () => {
    const files = await buildZip(null, ["an_pos", "an_desc", "an_model", "an_ols"], {
      includeGoldText: false,
    });
    const work = await mkdtemp(path.join(os.tmpdir(), "concord-honesty-py-"));
    try {
      for (const [member, bytes] of Object.entries(files)) {
        const target = path.join(work, member);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, Buffer.from(bytes));
      }
      const run = spawnSync(PYTHON, ["reproduce.py"], {
        cwd: work,
        encoding: "utf8",
        timeout: 120000,
      });
      assert.equal(
        run.status,
        0,
        `reproduce.py exited ${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
      );
      assert.ok(run.stdout.includes("analysis an_pos") && run.stdout.includes("analysis an_desc"));
      assert.ok(
        run.stdout.includes("analysis an_model") && run.stdout.includes("analysis an_ols"),
        `regression blocks must execute:\n${run.stdout}`,
      );
      // proportions: 2 cells + diff (an_pos) + 2 cells (an_desc) = 10 OKs;
      // regressions: 2 coefficients × (est + se) × 2 analyses = 8 OKs
      assert.ok(
        (run.stdout.match(/OK /g) ?? []).length >= 16,
        `every cell + diff + coefficient checks OK:\n${run.stdout}`,
      );
      assert.ok(
        /OK .*(Intercept).* est/.test(run.stdout) && /satisfaction.* se/.test(run.stdout),
        `regression coefficient checks must print:\n${run.stdout}`,
      );
      assert.ok(
        /All Concord numbers reproduced to 1e-6/.test(run.stdout),
        "honest final line missing",
      );
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  },
);

test("corrected regressions are refit by the generated scripts: pseudo-outcome rebuild + inline fit + assertions against the stored coefficients", async () => {
  const files = await buildZip(null, ["an_model", "an_ols"], { includeGoldText: false });
  const r = strFromU8(files["reproduce.R"]);
  const py = strFromU8(files["reproduce.py"]);
  const readme = strFromU8(files["README.md"]);

  // both scripts name both regression analyses
  for (const text of [r, py]) {
    assert.ok(text.includes("analysis an_model"), "logit block missing");
    assert.ok(text.includes("analysis an_ols"), "OLS block missing");
  }

  // the covariate comes from the archived unit meta and rows with non-numeric
  // covariates drop (Concord's usable-row rule)
  assert.ok(r.includes("meta_satisfaction"), "R must read the meta_ covariate column");
  assert.ok(py.includes('"meta_satisfaction"'), "py must read the meta_ covariate column");
  assert.ok(
    /non-numeric/i.test(r) && /non-numeric/i.test(py),
    "both scripts must state the usable-row rule",
  );

  // logit: the refit replicates Concord's exact Newton iteration (clamp,
  // weight floor, stopping rule) so 1e-6 holds for an iterative fit — the
  // tolerance and its justification must be stated in BOTH scripts and README
  assert.ok(/pmin\(pmax\(/.test(r), "R logit must clamp eta like Concord");
  assert.ok(/1e-10/.test(r), "R logit must carry Concord's weight floor/stopping tolerance");
  assert.ok(/np\.clip\(/.test(py), "py logit must clamp eta like Concord");
  assert.ok(
    /max\(np\.abs\(step\)\) < 1e-10|np\.max\(np\.abs\(step\)\) < 1e-10/.test(py),
    "py logit must stop on Concord's step rule",
  );
  for (const text of [r, py, readme]) {
    assert.ok(/1e-6/.test(text), "the regression tolerance must be stated");
    assert.ok(/Newton|iterative/i.test(text), "the iterative-logit justification must be stated");
  }

  // every stored coefficient (est AND se) is embedded at full precision and asserted
  for (const c of [...A.expected.logit, ...A.expected.olsCoef]) {
    assert.ok(
      py.includes(String(c.est)) && py.includes(String(c.se)),
      `stored coef ${c.name} missing from reproduce.py`,
    );
    assert.ok(
      r.includes(String(c.est)) && r.includes(String(c.se)),
      `stored coef ${c.name} missing from reproduce.R`,
    );
  }
  assert.ok(/stopifnot\(/.test(r), "R must assert with stopifnot");

  // OLS variance is the HC0 sandwich with NO degrees-of-freedom inflation
  assert.ok(
    /HC0|no n\/\(n-p\)|without.*n\/\(n.p\)/i.test(py),
    "py must name the HC0 (uninflated) sandwich",
  );

  // coverage statements now claim regressions; the roadmap caveat is gone
  for (const member of ["reproduce.R", "reproduce.py", "README.md"]) {
    const text = strFromU8(files[member]);
    assert.ok(
      !/corrected regression refits are not included/.test(text),
      `${member} must not still disclaim regression refits`,
    );
    assert.ok(
      !/generated refit code is on the roadmap/.test(text),
      `${member} must drop the roadmap caveat`,
    );
    assert.ok(
      !text.includes("No DSL-corrected analyses were included in this archive"),
      `${member} must not deny corrected analyses that ship in the same zip`,
    );
  }
});

test("analyses the scripts still cannot refit get an honest coverage statement, never a false 'no corrected analyses' claim", async () => {
  // a PPI-corrected analysis: stored values only — the scripts must say so
  const clone = structuredClone(A.project);
  clone.analyses.push({
    id: "an_ppi",
    kind: "descriptive",
    spec: { instrumentId: "inst_h", runId: "run_h", corpusId: "corp_h", goldsetId: "gs_h" },
    results: { estimator: "ppiMean", outcome: "label", est: 0.5, se: 0.1 },
    level: "corrected",
    createdAt: "2026-06-02T11:30:00.000Z",
  });
  const files = await buildZip(clone, ["an_pos", "an_model", "an_ppi"], { includeGoldText: false });
  for (const member of ["reproduce.R", "reproduce.py", "README.md"]) {
    const text = strFromU8(files[member]);
    assert.ok(
      /proportion cells and corrected regression .* script-verified/.test(text),
      `${member} must state the script coverage`,
    );
    assert.ok(
      text.includes("analyses/an_ppi.json"),
      `${member} must point at the stored estimates`,
    );
    assert.ok(
      /stored values/.test(text),
      `${member} must say uncovered estimates ship as stored values`,
    );
    assert.ok(
      !text.includes("analyses/an_model.json (estimator"),
      `${member} must not list the refit regression as uncovered`,
    );
    assert.ok(
      !text.includes("No DSL-corrected analyses were included in this archive"),
      `${member} must not deny corrected analyses that ship in the same zip`,
    );
  }

  // archive with ONLY the uncovered analysis: still no false denial
  const only = await buildZip(clone, ["an_ppi"], { includeGoldText: false });
  const r = strFromU8(only["reproduce.R"]);
  const py = strFromU8(only["reproduce.py"]);
  assert.ok(!r.includes("No DSL-corrected analyses were included in this archive"));
  assert.ok(!py.includes("No DSL-corrected analyses in this archive"));
  assert.ok(r.includes("analyses/an_ppi.json") && py.includes("analyses/an_ppi.json"));
});

test("legacy archives without a recorded positive value fall back to numeric labels, with the fallback named", async () => {
  const clone = structuredClone(A.project);
  const an = clone.analyses.find((a) => a.id === "an_pos");
  delete an.results.positive;
  const files = await buildZip(clone, ["an_pos"], { includeGoldText: false });
  const r = strFromU8(files["reproduce.R"]);
  const py = strFromU8(files["reproduce.py"]);
  assert.ok(r.includes("d$yhat <- as.numeric(d$label)"), "R numeric fallback missing");
  assert.ok(/No positive label value was recorded/.test(r), "R must name the fallback");
  assert.ok(
    py.includes('pd.to_numeric(d["label"], errors="coerce")'),
    "py numeric fallback missing",
  );
  assert.ok(/No positive label value was recorded/.test(py), "py must name the fallback");
});

test("uncertainty-design archives drop the unconditional unbiasedness claim", async () => {
  const clone = structuredClone(A.project);
  clone.goldsets.find((g) => g.id === "gs_h").design = "uncertainty";
  const files = await buildZip(clone, ["an_pos"], { includeGoldText: false });
  const py = strFromU8(files["reproduce.py"]);
  const r = strFromU8(files["reproduce.R"]);
  assert.ok(
    !py.includes("Unbiased regardless of machine-error structure because pi is a design quantity."),
    "the unconditional guarantee must not ship with an uncertainty-targeted design",
  );
  assert.ok(/does not apply/.test(py), "py must state the guarantee does not apply");
  assert.ok(/nominal n\/N over a deterministic uncertainty ranking/.test(py));
  assert.ok(/does not apply/.test(r), "R must state the guarantee does not apply");

  // probability designs keep the guarantee
  const srs = await buildZip(null, ["an_pos"], { includeGoldText: false });
  assert.ok(
    strFromU8(srs["reproduce.py"]).includes(
      "Unbiased regardless of machine-error structure because pi is a design quantity.",
    ),
  );
});

test("README: codebook is described as recorded at export time, not as frozen", async () => {
  const files = await buildZip(null, ["an_pos"], { includeGoldText: false });
  const readme = strFromU8(files["README.md"]);
  assert.ok(
    /codebook\.md.*as recorded at export time/.test(readme),
    "codebook line must claim export-time state",
  );
  assert.ok(
    !/codebook\.md.*as frozen/.test(readme),
    "constructs are never frozen — the README must not say so",
  );
});

// ======================================================== methods: the prose

test("methods: snapshot recording is claimed as recorded-not-verified, with the identifiers", async () => {
  const { markdown } = await gen();
  assert.ok(
    /A model snapshot identifier was recorded for every juror/.test(markdown),
    "recorded-identifier sentence missing",
  );
  assert.ok(
    markdown.includes("claude-judge-a-20260101") && markdown.includes("claude-judge-b-20260101"),
    "snapshot ids missing",
  );
  assert.ok(/records but does not verify/.test(markdown), "non-verification disclosure missing");
  assert.ok(
    !/The model snapshot was pinned for every call in this run/.test(markdown),
    "the old verified-pin overclaim must be gone",
  );
});

test("methods: seed clause is conditional on whether the provider transmits a seed", async () => {
  // anthropic does NOT accept a seed parameter
  const { markdown } = await gen();
  assert.ok(/A seed of 11 was recorded/.test(markdown), "recorded-seed sentence missing");
  assert.ok(
    /does not accept a seed parameter/.test(markdown),
    "non-transmission disclosure missing",
  );
  assert.ok(
    !/a fixed seed of 11/.test(markdown),
    "must not claim a fixed seed for a non-transmitting provider",
  );

  // openai DOES transmit the seed
  const clone = structuredClone(A.project);
  for (const j of clone.instruments[0].payload.jurors) j.provider = "openai";
  const m2 = await gen(clone);
  assert.ok(
    /a fixed seed of 11/.test(m2.markdown),
    "transmitting providers earn the fixed-seed clause",
  );
  assert.ok(!/does not accept a seed parameter/.test(m2.markdown));
});

test("methods: escalation sentence is conditional on a configured Director", async () => {
  // run_h has directorModel "director-9000"
  const { markdown } = await gen();
  assert.ok(/2 units were escalated/.test(markdown));
  assert.ok(
    /unusually long text/.test(markdown),
    "the length trigger must be in the predicate list",
  );
  assert.ok(markdown.includes("director-9000"));
  assert.ok(/on disagreement the Director's verdict replaced the primary judgment/.test(markdown));

  // run_h2 recorded NO Director
  const m2 = await gen(null, "an_null");
  assert.ok(/1 unit was escalated/.test(m2.markdown));
  assert.ok(
    /no Director model \(not recorded\)/.test(m2.markdown),
    "null Director must render as not recorded",
  );
  assert.ok(/flags carry no second opinion/.test(m2.markdown));
  assert.ok(
    !/replaced the primary judgment/.test(m2.markdown),
    "must not claim replacement without a Director",
  );
});

test("methods: the construct entry always reads as recorded at export time; freezing is disclosed as prompt-only", async () => {
  const { markdown } = await gen();
  assert.ok(
    /As recorded at export time, the entry specifies/.test(markdown),
    "export-time wording must be unconditional",
  );
  assert.ok(
    /which Concord does not yet take/.test(markdown),
    "the missing construct-snapshot disclosure is due on frozen instruments",
  );

  const clone = structuredClone(A.project);
  clone.instruments[0].frozen = false;
  delete clone.instruments[0].certificate;
  const m2 = await gen(clone);
  assert.ok(/As recorded at export time, the entry specifies/.test(m2.markdown));
  assert.ok(
    !m2.markdown.includes("As frozen for this analysis"),
    "unfrozen: no frozen phrasing at all",
  );
});

test("methods: inductive-origin constructs state the corpus-mining provenance; draft and legacy keep the draft wording", async () => {
  // origin "inductive" (stamped by the Inductive-mode accept path): the
  // provenance sentence names the corpus-mining pass and the adoption
  const inductive = structuredClone(A.project);
  Object.assign(inductive.constructs[0], {
    authoredBy: "director",
    humanTouched: false,
    origin: "inductive",
    draftedFrom: "corp_h",
  });
  const m1 = await gen(inductive);
  assert.ok(
    /originated from a Director corpus-mining pass over the corpus "Survey" and was adopted by the researcher/.test(
      m1.markdown,
    ),
    "inductive origin sentence (with resolved corpus) missing",
  );
  assert.ok(
    /the codebook entry has not been edited by a human/.test(m1.markdown),
    "unedited inductive construct keeps the no-human-edit disclosure",
  );
  assert.ok(
    !/The codebook entry was drafted by the AI Director/.test(m1.markdown),
    "draft wording must not ride an inductive construct",
  );

  // draftedFrom unresolvable (corpus gone) → the corpus clause drops, the rest stands
  const lost = structuredClone(inductive);
  lost.constructs[0].draftedFrom = "corp_gone";
  const m2 = await gen(lost);
  assert.ok(
    /originated from a Director corpus-mining pass and was adopted by the researcher/.test(
      m2.markdown,
    ),
    "unresolvable draftedFrom must drop the corpus clause, not invent a name",
  );
  assert.ok(
    !m2.markdown.includes("corp_gone"),
    "a dangling corpus id must not leak into the prose",
  );

  // origin "draft" (deductive Director draft) keeps the current sentence
  const draft = structuredClone(A.project);
  Object.assign(draft.constructs[0], {
    authoredBy: "director",
    humanTouched: false,
    origin: "draft",
  });
  const m3 = await gen(draft);
  assert.ok(
    /The codebook entry was drafted by the AI Director and has not been edited by a human/.test(
      m3.markdown,
    ),
  );
  assert.ok(
    !/corpus-mining/.test(m3.markdown),
    "draft constructs must not claim a corpus-mining origin",
  );

  // absent origin (legacy construct) keeps the current wording
  const legacy = structuredClone(A.project);
  Object.assign(legacy.constructs[0], { authoredBy: "director", humanTouched: false });
  delete legacy.constructs[0].origin;
  const m4 = await gen(legacy);
  assert.ok(
    /The codebook entry was drafted by the AI Director and has not been edited by a human/.test(
      m4.markdown,
    ),
  );
  assert.ok(
    !/corpus-mining/.test(m4.markdown),
    "legacy constructs (no origin) keep the current wording",
  );
});

test("methods: uncertainty designs disclose nominal pi and the lost guarantee", async () => {
  const clone = structuredClone(A.project);
  clone.goldsets.find((g) => g.id === "gs_h").design = "uncertainty";
  const { markdown } = await gen(clone);
  assert.ok(
    /nominal n\/N over a deterministic uncertainty ranking/.test(markdown),
    "nominal-pi sentence missing",
  );
  assert.ok(
    /design-based unbiasedness guarantee does not apply/.test(markdown),
    "lost-guarantee sentence missing",
  );
  assert.ok(
    !/fixed by the design and recorded at sampling time/.test(markdown),
    "must not claim design-fixed pi for uncertainty sampling",
  );

  // srs keeps the design claim and no hedge
  const base = await gen();
  assert.ok(/fixed by the design and recorded at sampling time/.test(base.markdown));
  assert.ok(!/does not apply/.test(base.markdown));
});

test("methods: ordinal constructs name the weighted kappa", async () => {
  const clone = structuredClone(A.project);
  clone.constructs[0].type = "ordinal";
  const { markdown } = await gen(clone);
  assert.ok(
    /linear-weighted Cohen's kappa/.test(markdown),
    "ordinal kappa must be named linear-weighted",
  );

  const base = await gen();
  assert.ok(/Cohen's kappa = /.test(base.markdown));
  assert.ok(!/linear-weighted/.test(base.markdown), "binary constructs keep the plain name");
});

test("methods: hand-queued gold rows are reported separately from the design sample", async () => {
  const { markdown } = await gen();
  assert.ok(
    /n = 4 design-sampled units \(π recorded\)/.test(markdown),
    "design-sampled count must exclude queued rows",
  );
  assert.ok(
    /1 hand-queued unit excluded from the corrected estimators/.test(markdown),
    "queued-row disclosure missing",
  );

  const clone = structuredClone(A.project);
  const gs = clone.goldsets.find((g) => g.id === "gs_h");
  gs.sample = gs.sample.filter((s) => typeof s.pi === "number");
  const m2 = await gen(clone);
  assert.ok(/n = 4 units was drawn/.test(m2.markdown), "no queued rows: plain phrasing");
  assert.ok(!/hand-queued/.test(m2.markdown));
});

test("methods: quarantine names the full structured-output failure surface", async () => {
  const { markdown } = await gen();
  assert.ok(
    /failed structured-output enforcement \(schema validation after constrained repair, provider refusal, or truncation\)/.test(
      markdown,
    ),
  );
});

test("methods: the gold standard names the consensus rule beside adjudication", async () => {
  const { markdown } = await gen();
  assert.ok(
    /adjudicated labels, together with units where at least two coders agreed unanimously, constitute the gold standard/.test(
      markdown,
    ),
  );
});

test("methods: per-cell corrected sentence carries its naive companion", async () => {
  const { markdown } = await gen(null, "an_desc"); // no diff → cells[0] sentence
  const naive = A.expected.cellYes.naive.est;
  assert.ok(
    new RegExp(`against a naive estimate of ${naive.toFixed(3).replace(".", "\\.")}`).test(
      markdown,
    ),
    "the cells[0] sentence must print the naive value beside the corrected one",
  );
});

test("methods: cost is described as estimate-grade static pricing over metered tokens", async () => {
  const { markdown } = await gen();
  assert.ok(/metered token counts priced at estimate-grade static rates/.test(markdown));
  assert.ok(
    !/at a metered cost of \$/.test(markdown),
    "the old metered-cost phrasing must be gone",
  );
});

test("methods: blindness is claimed about the interface, not just the coders", async () => {
  const { markdown } = await gen();
  assert.ok(
    /blind coding interface, which serves coders no machine labels and no co-coder labels/.test(
      markdown,
    ),
  );
});

test("methods: per-sentence citation discipline holds over all new prose", async () => {
  for (const id of ["an_pos", "an_desc", "an_null"]) {
    const { markdown } = await gen(null, id);
    for (const line of markdown.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || t.startsWith("|") || t.startsWith(">") || t.startsWith("-"))
        continue;
      for (const m of line.matchAll(/\.(?=\s|$)/g)) {
        assert.equal(line[m.index - 1], "]", `unsourced sentence in (${id}): ${line}`);
      }
    }
    assert.ok(!/undefined|NaN/.test(markdown), `placeholder leak in ${id}`);
  }
});

// LAST of the part-A methods tests: appends a ledger event that flips the
// silver-tuning order proof for every later generate() against this fixture.
test("methods: silver-tuning order claim downgrades when the ledger cannot prove it", async () => {
  const before_ = await gen();
  assert.ok(
    /Before any human validation, the instrument was tuned/.test(before_.markdown),
    "order-proven claim missing",
  );

  // a RE-tune after human labels: the latest silver_tuned now postdates them
  await ledger.append(
    A.dir,
    "director",
    "instrument.silver_tuned",
    { instrumentId: "inst_h", goldsetId: "gs_s" },
    { iterations: 1, finalAgreement: 0.92 },
  );
  const { markdown } = await gen();
  assert.ok(!/Before any human validation/.test(markdown), "order claim without ledger proof");
  assert.ok(
    /does not establish whether tuning preceded human validation/.test(markdown),
    "hedge sentence missing",
  );
});

// ================================================== routes: preview + goldText

let tmpProjects;
let tmpConfig;
let srv;
let base;
const SLUG = "honesty-route";

before(async () => {
  tmpProjects = await mkdtemp(path.join(os.tmpdir(), "concord-honesty-srv-"));
  tmpConfig = await mkdtemp(path.join(os.tmpdir(), "concord-honesty-cfg-"));
  process.env.CONCORD_PROJECTS_DIR = tmpProjects;
  process.env.CONCORD_CONFIG_DIR = tmpConfig;
  const { startServer } = await import("../../server/index.js");
  srv = await startServer({ port: 0 });
  base = `http://127.0.0.1:${srv.port}`;

  const res = await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Honesty Route", slug: SLUG }),
  });
  assert.equal(res.status, 200, await res.text());

  const corpusId = "corp_r";
  await appendNdjson(path.join(pdir(SLUG), "corpora", corpusId, "units.ndjson"), {
    id: "ur0",
    text: "SECRET-VERBATIM about pay.",
    meta: { dept: "sales" },
  });
  await appendNdjson(path.join(pdir(SLUG), "corpora", corpusId, "units.ndjson"), {
    id: "ur1",
    text: "Another SECRET-VERBATIM line.",
    meta: { dept: "ops" },
  });
  await updateProject(SLUG, (p) => {
    p.corpora = [
      {
        id: corpusId,
        name: "R",
        source: { filename: "r.csv", format: "csv", rows: 2 },
        unitization: { scheme: "response" },
        unitCount: 2,
      },
    ];
    p.goldsets = [
      {
        id: "gs_r",
        constructId: "c_r",
        tier: "gold",
        design: "srs",
        status: "complete",
        sample: [
          { unitId: "ur0", pi: 0.5 },
          { unitId: "ur1", pi: 0.5 },
        ],
        coders: [{ coderId: "a", blind: true, labels: { ur0: "yes", ur1: "no" } }],
        adjudicated: { ur0: "yes", ur1: "no" },
      },
    ];
    p.analyses = [
      {
        id: "an_r",
        spec: { corpusId },
        level: "exploratory",
        results: {},
        kind: "descriptive",
        createdAt: new Date().toISOString(),
      },
    ];
  });
});

after(async () => {
  await srv?.close();
  delete process.env.CONCORD_PROJECTS_DIR;
  delete process.env.CONCORD_CONFIG_DIR;
  await rm(tmpProjects, { recursive: true, force: true }).catch(() => {});
  await rm(tmpConfig, { recursive: true, force: true }).catch(() => {});
});

const exportEvents = async () =>
  (await ledger.query(pdir(SLUG))).filter((e) => e.type === "export.methods");

test("route: GET exports/methods/preview renders without ledgering; the export of record still ledgers", async () => {
  assert.equal((await exportEvents()).length, 0, "fresh project: no export.methods yet");

  const pre = await fetch(`${base}/api/projects/${SLUG}/exports/methods/preview?analysisId=an_r`);
  assert.equal(pre.status, 200, await pre.clone().text());
  const preBody = await pre.json();
  assert.equal(preBody.ok, true);
  assert.match(preBody.data.markdown, /^# Methods/);
  assert.ok(
    preBody.data.markdown.includes("Preview — not an export of record"),
    "preview banner missing",
  );
  assert.ok(Array.isArray(preBody.data.citations) && preBody.data.citations.length > 0);
  assert.equal((await exportEvents()).length, 0, "a preview must NOT mint an export.methods event");

  const rec = await fetch(`${base}/api/projects/${SLUG}/exports/methods?analysisId=an_r`);
  assert.equal(rec.status, 200);
  const recBody = await rec.json();
  assert.equal(recBody.ok, true);
  assert.ok(
    !recBody.data.markdown.includes("Preview — not an export of record"),
    "the record must not carry the preview banner",
  );
  assert.equal((await exportEvents()).length, 1, "the export of record ledgers exactly once");

  // another preview after the record: still no new event
  await fetch(`${base}/api/projects/${SLUG}/exports/methods/preview?analysisId=an_r`);
  assert.equal((await exportEvents()).length, 1);
});

test("route: ?goldText=0 ships gold labels and pi without the unit text", async () => {
  const withText = await fetch(`${base}/api/projects/${SLUG}/exports/replication?analyses=an_r`);
  assert.equal(withText.status, 200);
  const filesWith = unzipSync(new Uint8Array(await withText.arrayBuffer()));
  const csvWith = strFromU8(filesWith["gold/gs_r.csv"]);
  assert.ok(
    csvWith.split("\n")[0].split(",").includes("text"),
    "default archive carries the text column",
  );
  assert.ok(csvWith.includes("SECRET-VERBATIM"), "default archive carries unit verbatims");
  assert.equal(JSON.parse(strFromU8(filesWith["MANIFEST.json"])).includesGoldText, true);

  const noText = await fetch(
    `${base}/api/projects/${SLUG}/exports/replication?analyses=an_r&goldText=0`,
  );
  assert.equal(noText.status, 200);
  const filesNo = unzipSync(new Uint8Array(await noText.arrayBuffer()));
  const csvNo = strFromU8(filesNo["gold/gs_r.csv"]);
  assert.ok(
    !csvNo.split("\n")[0].split(",").includes("text"),
    "goldText=0 must drop the text column",
  );
  assert.ok(!csvNo.includes("SECRET-VERBATIM"), "goldText=0 must not leak verbatims");
  assert.equal(JSON.parse(strFromU8(filesNo["MANIFEST.json"])).includesGoldText, false);
  assert.ok(
    strFromU8(filesNo["README.md"]).includes("Unit text was withheld at export"),
    "README must state the withholding",
  );
});
