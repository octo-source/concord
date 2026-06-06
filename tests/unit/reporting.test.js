// Reporting layer tests: methods generator, replication archive, report canvas.
//
// The fixture is a REAL project bundle built programmatically in a temp dir
// with the Wave-1 core modules (objects/store/ledger) and real statistics
// (agreement/correction), so every number the reporting layer cites is a
// number Concord actually computed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { unzipSync, strFromU8 } from "fflate";

import { sha256, unitId } from "../../server/core/ids.js";
import { saveProject, appendNdjson } from "../../server/core/store.js";
import * as ledger from "../../server/core/ledger.js";
import {
  createProject, createConstruct, createInstrument, createGoldSet, createRun, createAnalysis, freeze,
} from "../../server/core/objects.js";
import { percentAgreement, cohenKappa, krippendorffAlpha, perClass, confusion } from "../../server/stats/agreement.js";
import { bootstrapCI } from "../../server/stats/boot.js";
import { dslProportion, dslDiff } from "../../server/stats/correction.js";
import { ConcordError } from "../../server/core/errors.js";

import * as methods from "../../server/reporting/methods.js";
import * as replication from "../../server/reporting/replication.js";
import * as report from "../../server/reporting/report.js";

// ------------------------------------------------------------------ fixture

// Build once for the whole file (tests in a file run serially). Exports from
// the reporting modules may append ledger events; that is part of the design
// and the chain stays valid throughout.
async function buildFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "concord-reporting-"));
  const slug = "acme-exit";
  const projectDir = path.join(root, slug);
  await mkdir(projectDir, { recursive: true });

  const corpusId = "corp_demo";
  const createdAt = "2026-06-01T08:00:00.000Z";

  // 12 units, 6 sales + 6 ops. u4's text exercises CSV escaping (quotes,
  // comma, embedded newline); u1's text exercises HTML escaping.
  const texts = [
    "Pay was far below market and raises never came.",
    "<b>bold claim</b> about pay: salary bands felt arbitrary.",
    "I left because my compensation stagnated for three years.",
    "Underpaid relative to peers; bonus structure was opaque.",
    'She said "I quit", then left.\nSecond line about salary.',
    "Great team, hybrid schedule worked well for me.",
    "Management never listened to the operations floor.",
    "Shift scheduling chaos made planning life impossible.",
    "The pay freeze during record profits felt insulting.",
    "My manager blocked every transfer request I made.",
    "Burnout from chronic understaffing on night shifts.",
    "No growth path beyond senior operator, and wages lagged.",
  ];
  const depts = ["sales", "sales", "sales", "sales", "sales", "sales", "ops", "ops", "ops", "ops", "ops", "ops"];
  const units = texts.map((text, i) => ({
    id: unitId(corpusId, i, text),
    text,
    // u3's note meta exercises CSV formula-injection hardening (leading "=")
    meta: { dept: depts[i], satisfaction: (i % 5) + 1, ...(i === 3 ? { note: "=2+5" } : {}) },
    pos: { row: i },
  }));
  for (const u of units) {
    await appendNdjson(path.join(projectDir, "corpora", corpusId, "units.ndjson"), u);
  }

  // machine labels (yhat) and the gold design (every 2nd unit, pi = 6/12).
  // u2 is a machine false negative on a gold unit, so the DSL correction
  // visibly moves the sales estimate away from the naive plug-in.
  const yhat = [1, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1];
  const goldIdx = [0, 2, 4, 6, 8, 10];
  const pi = 0.5;
  const adjudicatedY = { 0: 1, 2: 1, 4: 0, 6: 0, 8: 1, 10: 0 }; // by unit index
  const coderA = { 0: 1, 2: 1, 4: 0, 6: 0, 8: 1, 10: 0 };
  const coderB = { 0: 1, 2: 1, 4: 1, 6: 0, 8: 1, 10: 0 }; // disagrees on u4

  // ---- construct (Director-drafted, human-edited). The definition is
  // deliberately MULTI-SENTENCE: interpolating it must not break the
  // per-sentence citation contract (internal periods demote to semicolons).
  const construct = createConstruct({
    id: "c_pay",
    name: "Pay concern",
    type: "binary",
    definition: "Mentions of compensation, salary, bonus or pay fairness as a stated reason for dissatisfaction or leaving. Includes raises and equity grievances. Excludes pay mentioned with no dissatisfaction link.",
    criteria: {
      include: ["explicit pay or salary complaints", "bonus or equity grievances"],
      exclude: ["benefits-only complaints", "workload complaints without a pay link"],
    },
    edgeCases: ["pay mentioned positively counts as 0"],
    examples: [
      { text: "Salary was 20% under market", label: 1, kind: "positive" },
      { text: "I loved the work but the commute killed me", label: 0, kind: "negative" },
      { text: "They paid well yet promotions stalled", label: 0, kind: "nearmiss" },
    ],
    authoredBy: "director",
    humanTouched: true,
    createdAt,
  });

  // ---- judge instrument: silver-tuned, stability-checked, frozen with certificate
  const judgePayload = {
    provider: "mock",
    model: "mock-judge-1",
    snapshot: "mock-judge-1@2026-05",
    params: { temperature: 0, maxTokens: 400, seed: 7 },
    promptTemplate: "You are a careful qualitative coder.\n{{definition}}\n{{criteria}}\n{{examples}}\nUnit:\n{{unit}}\nReturn JSON {rationale, label, confidence}.",
    schema: { type: "binary" },
    rationaleFirst: true,
    workerClass: "mid",
  };
  const inst = createInstrument({
    id: "inst_judge",
    constructId: construct.id,
    kind: "judge",
    name: "Pay judge",
    payload: judgePayload,
    authoredBy: "director",
    humanTouched: true,
    createdAt,
  });
  inst.silver = {
    goldsetId: "gs_silver",
    iterations: [
      { versionHash: inst.versionHash, agreement: 0.74, note: "baseline prompt" },
      { versionHash: inst.versionHash, agreement: 0.86, note: "tightened exclusion criteria" },
    ],
  };
  inst.stability = { alpha: 0.91, k: 3, n: 100, ranAt: "2026-06-01T12:00:00.000Z" };
  inst.level = "calibrated";

  // human reliability on the gold set (computed with the REAL stats engine)
  const humanRows = goldIdx.flatMap((i) => [
    { unitId: units[i].id, coder: "coder_a", value: coderA[i] },
    { unitId: units[i].id, coder: "coder_b", value: coderB[i] },
  ]);
  const humanAgreement = {
    n: goldIdx.length,
    percent: percentAgreement(humanRows),
    kappa: cohenKappa(humanRows),
    alpha: krippendorffAlpha(humanRows, { level: "nominal" }),
    ci: bootstrapCI(humanRows, (d) => krippendorffAlpha(d, { level: "nominal" }), { B: 200, seed: 3 }),
  };

  // machine-vs-gold certificate agreement (also real)
  const machineRows = goldIdx.flatMap((i) => [
    { unitId: units[i].id, coder: "gold", value: adjudicatedY[i] },
    { unitId: units[i].id, coder: "machine", value: yhat[i] },
  ]);
  const conf = confusion(machineRows, "gold", "machine");
  const machineAgreement = {
    n: goldIdx.length,
    percent: percentAgreement(machineRows),
    kappa: cohenKappa(machineRows),
    alpha: krippendorffAlpha(machineRows, { level: "nominal" }),
    perClass: perClass(machineRows, "gold"),
    confusion: conf.matrix,
    labels: conf.labels,
    ci: bootstrapCI(machineRows, (d) => krippendorffAlpha(d, { level: "nominal" }), { B: 200, seed: 7 }),
  };
  const certificate = {
    frozenAt: "2026-06-02T09:00:00.000Z",
    goldsetId: "gs_gold",
    agreement: machineAgreement,
    humanAgreement,
    versionHash: inst.versionHash,
    modelPinned: true,
  };
  freeze(inst, certificate);

  // ---- dictionary instrument (exploratory; exercises dictionaries/ + hatching)
  const dict = createInstrument({
    id: "inst_dict",
    constructId: construct.id,
    kind: "dictionary",
    name: "Pay terms",
    payload: {
      categories: [{ name: "pay_terms", terms: [{ term: "pay" }, { term: "salary" }, { term: "underpa*" }, { term: '"pay freeze"' }] }],
      negation: { enabled: true, window: 3 },
      scoring: "percentOfWords",
    },
    authoredBy: "human",
    createdAt,
  });

  // ---- goldsets (silver Director-labeled + gold human-labeled)
  const silverIdx = [1, 3, 7, 9];
  const gsSilver = createGoldSet({
    id: "gs_silver",
    constructId: construct.id,
    tier: "silver",
    design: "srs",
    sample: silverIdx.map((i) => ({ unitId: units[i].id, pi: silverIdx.length / units.length })),
    coders: [{
      coderId: "director", blind: true,
      labels: Object.fromEntries(silverIdx.map((i) => [units[i].id, yhat[i]])),
      startedAt: "2026-06-01T10:00:00.000Z", finishedAt: "2026-06-01T10:05:00.000Z",
    }],
    status: "complete",
  });
  const gsGold = createGoldSet({
    id: "gs_gold",
    constructId: construct.id,
    tier: "gold",
    design: "srs",
    sample: goldIdx.map((i) => ({ unitId: units[i].id, pi })),
    coders: [
      { coderId: "coder_a", blind: true, labels: Object.fromEntries(goldIdx.map((i) => [units[i].id, coderA[i]])), startedAt: "2026-06-01T14:00:00.000Z", finishedAt: "2026-06-01T15:00:00.000Z" },
      { coderId: "coder_b", blind: true, labels: Object.fromEntries(goldIdx.map((i) => [units[i].id, coderB[i]])), startedAt: "2026-06-01T14:00:00.000Z", finishedAt: "2026-06-01T15:10:00.000Z" },
    ],
    humanAgreement,
    adjudicated: Object.fromEntries(goldIdx.map((i) => [units[i].id, adjudicatedY[i]])),
    status: "complete",
  });
  await mkdir(path.join(projectDir, "gold"), { recursive: true });
  await writeFile(path.join(projectDir, "gold", "gs_silver.json"), JSON.stringify(gsSilver, null, 2), "utf8");
  await writeFile(path.join(projectDir, "gold", "gs_gold.json"), JSON.stringify(gsGold, null, 2), "utf8");

  // ---- run + outputs
  const run = createRun({
    id: "run_1",
    instrumentId: inst.id,
    versionHash: inst.versionHash,
    corpusId,
    status: "complete",
    checkpoint: { done: 12, total: 12 },
    cost: { estUSD: 0.05, actualUSD: 0.04, inputTokens: 5200, outputTokens: 1900 },
    escalation: { count: 1, directorModel: null },
    startedAt: "2026-06-02T10:00:00.000Z",
    finishedAt: "2026-06-02T10:06:00.000Z",
    provider: "mock",
    model: "mock-judge-1",
    snapshot: "mock-judge-1@2026-05",
    pinned: true,
  });
  await mkdir(path.join(projectDir, "runs", run.id), { recursive: true });
  await writeFile(path.join(projectDir, "runs", run.id, "run.json"), JSON.stringify(run, null, 2), "utf8");
  for (let i = 0; i < units.length; i++) {
    await appendNdjson(path.join(projectDir, "runs", run.id, "outputs.ndjson"), {
      unitId: units[i].id,
      juror: inst.versionHash,
      label: yhat[i],
      confidence: 0.6 + 0.03 * i,
      rationale: `Mentions ${yhat[i] ? "a pay grievance" : "no pay content"} in the response`,
      escalated: i === 4,
      repaired: false,
      cacheHit: i === 7,
    });
  }

  // ---- the DSL-corrected crosstab analysis, numbers from the REAL estimator
  const mkDslUnits = (idxs) => idxs.map((i) => (
    i in adjudicatedY ? { yhat: yhat[i], y: adjudicatedY[i], pi } : { yhat: yhat[i] }
  ));
  const salesIdx = [0, 1, 2, 3, 4, 5];
  const opsIdx = [6, 7, 8, 9, 10, 11];
  const sales = dslProportion(mkDslUnits(salesIdx));
  const ops = dslProportion(mkDslUnits(opsIdx));
  const diff = dslDiff(mkDslUnits(salesIdx), mkDslUnits(opsIdx));
  const anDsl = createAnalysis({
    id: "an_dsl",
    kind: "crosstab",
    spec: {
      instrumentId: inst.id, runId: run.id, corpusId, goldsetId: gsGold.id,
      rows: "pay_concern", cols: "dept", estimator: "dsl-proportion",
    },
    results: {
      estimator: "dsl-proportion",
      outcome: "pay_concern",
      groupBy: "dept",
      cells: [
        { group: "ops", n: 6, nGold: 3, est: ops.est, se: ops.se, ciLo: ops.ciLo, ciHi: ops.ciHi, naive: ops.naive },
        { group: "sales", n: 6, nGold: 3, est: sales.est, se: sales.se, ciLo: sales.ciLo, ciHi: sales.ciHi, naive: sales.naive },
      ],
      diff: { a: "sales", b: "ops", est: diff.est, se: diff.se, ciLo: diff.ciLo, ciHi: diff.ciHi, naive: diff.naive },
    },
    level: "corrected",
    evidence: { cells: {
      ops: opsIdx.filter((i) => yhat[i] === 1).map((i) => units[i].id),
      sales: salesIdx.filter((i) => yhat[i] === 1).map((i) => units[i].id),
    } },
    createdAt: "2026-06-02T11:00:00.000Z",
  });
  const anExpl = createAnalysis({
    id: "an_expl",
    kind: "descriptive",
    spec: { instrumentId: dict.id, corpusId, measure: "prevalence" },
    results: {
      estimator: "naive-proportion",
      outcome: "pay_terms",
      groupBy: null,
      cells: [{ group: "all", n: 12, est: 5 / 12 }],
    },
    level: "exploratory",
    evidence: { cells: { all: [units[0].id, units[3].id] } },
    createdAt: "2026-06-02T11:30:00.000Z",
  });
  await mkdir(path.join(projectDir, "analyses"), { recursive: true });
  await writeFile(path.join(projectDir, "analyses", "an_dsl.json"), JSON.stringify(anDsl, null, 2), "utf8");
  await writeFile(path.join(projectDir, "analyses", "an_expl.json"), JSON.stringify(anExpl, null, 2), "utf8");

  // ---- PANEL fixture: 3 jurors + a per-unit "aggregate" row, run on the same
  // corpus/gold design. The aggregate (majority) labels differ from the judge
  // run at index 7, so the panel analysis has its own corrected numbers, and
  // an unfiltered (per-juror rows included) recomputation visibly diverges.
  const votesA = [1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1];
  const votesB = [1, 1, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1];
  const votesC = [1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1];
  const aggPanel = votesA.map((_, i) => (votesA[i] + votesB[i] + votesC[i] >= 2 ? 1 : 0));
  const panelPayload = {
    jurors: [
      { provider: "mock", model: "mock-a", snapshot: "mock-a@2026-05", params: { temperature: 0, maxTokens: 300, seed: 11 } },
      { provider: "mock", model: "mock-b", snapshot: "mock-b@2026-04", params: { temperature: 0, maxTokens: 300, seed: 11 } },
      { provider: "mock", model: "mock-c", snapshot: null, params: { temperature: 0.3, maxTokens: 300 } },
    ],
    aggregation: "majority",
    promptTemplate: "Panel coder.\n{{definition}}\n{{criteria}}\n{{examples}}\nUnit:\n{{unit}}\nReturn JSON {label, confidence}.",
    schema: { type: "binary" },
  };
  const instPanel = createInstrument({
    id: "inst_panel",
    constructId: construct.id,
    kind: "panel",
    name: "Pay panel",
    payload: panelPayload,
    authoredBy: "director",
    humanTouched: true,
    createdAt,
  });
  const runPanel = createRun({
    id: "run_panel",
    instrumentId: instPanel.id,
    versionHash: instPanel.versionHash,
    corpusId,
    status: "complete",
    checkpoint: { done: 12, total: 12 },
    cost: { estUSD: 0.09, actualUSD: 0.06, inputTokens: 15600, outputTokens: 5400 },
    escalation: { count: 0, directorModel: null },
    startedAt: "2026-06-03T10:00:00.000Z",
    finishedAt: "2026-06-03T10:09:00.000Z",
    provider: "mock",
    model: "mock-panel",
    snapshot: null,
    pinned: false,
  });
  await mkdir(path.join(projectDir, "runs", runPanel.id), { recursive: true });
  await writeFile(path.join(projectDir, "runs", runPanel.id, "run.json"), JSON.stringify(runPanel, null, 2), "utf8");
  const jurorVotes = { j_alpha: votesA, j_beta: votesB, j_gamma: votesC };
  for (let i = 0; i < units.length; i++) {
    for (const [j, votes] of Object.entries(jurorVotes)) {
      await appendNdjson(path.join(projectDir, "runs", runPanel.id, "outputs.ndjson"), {
        unitId: units[i].id, juror: j, label: votes[i], confidence: 0.55 + 0.02 * i,
        escalated: false, repaired: false, cacheHit: false,
      });
    }
    await appendNdjson(path.join(projectDir, "runs", runPanel.id, "outputs.ndjson"), {
      unitId: units[i].id, juror: "aggregate", label: aggPanel[i],
      escalated: false, repaired: false, cacheHit: false,
    });
  }
  const mkPanelUnits = (idxs) => idxs.map((i) => (
    i in adjudicatedY ? { yhat: aggPanel[i], y: adjudicatedY[i], pi } : { yhat: aggPanel[i] }
  ));
  const salesPanel = dslProportion(mkPanelUnits(salesIdx));
  const opsPanel = dslProportion(mkPanelUnits(opsIdx));
  const diffPanel = dslDiff(mkPanelUnits(salesIdx), mkPanelUnits(opsIdx));
  const anPanel = createAnalysis({
    id: "an_panel",
    kind: "crosstab",
    spec: {
      instrumentId: instPanel.id, runId: runPanel.id, corpusId, goldsetId: gsGold.id,
      rows: "pay_concern", cols: "dept", estimator: "dsl-proportion",
    },
    results: {
      estimator: "dsl-proportion",
      outcome: "pay_concern",
      groupBy: "dept",
      cells: [
        { group: "ops", n: 6, nGold: 3, est: opsPanel.est, se: opsPanel.se, ciLo: opsPanel.ciLo, ciHi: opsPanel.ciHi, naive: opsPanel.naive },
        { group: "sales", n: 6, nGold: 3, est: salesPanel.est, se: salesPanel.se, ciLo: salesPanel.ciLo, ciHi: salesPanel.ciHi, naive: salesPanel.naive },
      ],
      diff: { a: "sales", b: "ops", est: diffPanel.est, se: diffPanel.se, ciLo: diffPanel.ciLo, ciHi: diffPanel.ciHi, naive: diffPanel.naive },
    },
    level: "corrected",
    evidence: { cells: {} },
    createdAt: "2026-06-03T11:00:00.000Z",
  });
  await writeFile(path.join(projectDir, "analyses", "an_panel.json"), JSON.stringify(anPanel, null, 2), "utf8");

  // ---- incoherent-claim fixture: Corrected level but a naive estimator.
  // methods.generate must refuse to write a methods section for it.
  const anBad = createAnalysis({
    id: "an_bad",
    kind: "descriptive",
    spec: { instrumentId: inst.id, runId: run.id, corpusId, goldsetId: gsGold.id, measure: "prevalence", estimator: "naive-proportion" },
    results: { estimator: "naive-proportion", outcome: "pay_concern", groupBy: null, cells: [{ group: "all", n: 12, est: 0.42 }] },
    level: "corrected",
    createdAt: "2026-06-03T12:00:00.000Z",
  });
  await writeFile(path.join(projectDir, "analyses", "an_bad.json"), JSON.stringify(anBad, null, 2), "utf8");

  // ---- project.json
  const project = createProject({
    id: "p_fixture",
    name: "Acme Exit Interviews",
    slug,
    createdAt,
    privacyMode: "no-training",
    corpora: [{
      id: corpusId,
      name: "Exit survey responses",
      source: { filename: "exit.csv", format: "csv", rows: 12 },
      unitization: { scheme: "response" },
      unitCount: 12,
      createdAt,
    }],
    constructs: [construct],
    instruments: [inst, dict, instPanel],
    goldsets: [
      { id: gsSilver.id, constructId: construct.id, tier: "silver", design: "srs", status: "complete", n: gsSilver.sample.length },
      { id: gsGold.id, constructId: construct.id, tier: "gold", design: "srs", status: "complete", n: gsGold.sample.length },
    ],
    analyses: [
      { id: anDsl.id, kind: anDsl.kind, level: anDsl.level, createdAt: anDsl.createdAt },
      { id: anExpl.id, kind: anExpl.kind, level: anExpl.level, createdAt: anExpl.createdAt },
      { id: anPanel.id, kind: anPanel.kind, level: anPanel.level, createdAt: anPanel.createdAt },
    ],
    briefs: [{ id: "brief_1", corpusId, createdAt }],
  });
  await saveProject(project, root);

  // ---- ledger: the full provenance history per the Wave-1 taxonomy
  const L = {};
  const ev = async (key, actor, type, refs, payload) => { L[key] = await ledger.append(projectDir, actor, type, refs, payload); };
  await ev("projectCreated", "system", "project.created", { projectId: project.id }, { name: project.name, privacyMode: project.privacyMode });
  await ev("corpusImported", "human", "corpus.imported", { projectId: project.id, corpusId }, { filename: "exit.csv", format: "csv", rows: 12 });
  await ev("corpusUnitized", "system", "corpus.unitized", { corpusId }, { scheme: "response", unitCount: 12 });
  await ev("briefGenerated", "director", "brief.generated", { briefId: "brief_1", corpusId }, { paragraphs: 4 });
  await ev("constructCreated", "director", "construct.created", { constructId: construct.id }, { name: construct.name, type: construct.type });
  await ev("constructEdited", "human", "construct.edited", { constructId: construct.id }, { fields: ["definition", "examples"] });
  await ev("instrumentCreated", "director", "instrument.created", { instrumentId: inst.id }, { kind: "judge", constructId: construct.id });
  await ev("instrumentCompiled", "director", "instrument.compiled", { instrumentId: inst.id }, { versionHash: inst.versionHash, workerClass: "mid" });
  await ev("dictCreated", "human", "instrument.created", { instrumentId: dict.id }, { kind: "dictionary", constructId: construct.id });
  await ev("silverCreated", "director", "goldset.created", { goldsetId: gsSilver.id }, { tier: "silver", constructId: construct.id });
  await ev("silverSampled", "system", "goldset.sampled", { goldsetId: gsSilver.id }, { design: "srs", n: 4, piMin: 4 / 12, piMax: 4 / 12 });
  await ev("silverTuned", "director", "instrument.silver_tuned", { instrumentId: inst.id, goldsetId: gsSilver.id }, { iterations: 2, finalAgreement: 0.86 });
  await ev("stability", "system", "instrument.stability", { instrumentId: inst.id }, { alpha: 0.91, k: 3, n: 100, pass: true });
  await ev("goldCreated", "human", "goldset.created", { goldsetId: gsGold.id }, { tier: "gold", constructId: construct.id });
  await ev("goldSampled", "system", "goldset.sampled", { goldsetId: gsGold.id }, { design: "srs", n: 6, piMin: pi, piMax: pi });
  for (const coder of ["coder_a", "coder_b"]) {
    for (const i of goldIdx) {
      await ev(`label_${coder}_${i}`, "human", "goldset.label", { goldsetId: gsGold.id, unitId: units[i].id }, { coder });
    }
  }
  await ev("goldAgreement", "system", "goldset.agreement", { goldsetId: gsGold.id }, { n: 6, percent: humanAgreement.percent, kappa: humanAgreement.kappa, alpha: humanAgreement.alpha });
  await ev("goldAdjudicated", "human", "goldset.adjudicated", { goldsetId: gsGold.id }, { n: 6 });
  await ev("goldCompleted", "system", "goldset.completed", { goldsetId: gsGold.id }, {});
  await ev("frozen", "human", "instrument.frozen", { instrumentId: inst.id, goldsetId: gsGold.id }, { versionHash: inst.versionHash, kappa: machineAgreement.kappa, alpha: machineAgreement.alpha, modelPinned: true });
  await ev("preflight", "system", "run.preflight", { runId: run.id, instrumentId: inst.id, corpusId }, { units: 12, estUSD: 0.05 });
  await ev("runStarted", "human", "run.started", { runId: run.id, instrumentId: inst.id, corpusId }, { model: run.model, snapshot: run.snapshot });
  await ev("runCompleted", "system", "run.completed", { runId: run.id }, { done: 12, total: 12, actualUSD: 0.04 });
  await ev("analysisDsl", "system", "analysis.created", { analysisId: anDsl.id, runId: run.id, goldsetId: gsGold.id }, { kind: "crosstab", estimator: "dsl-proportion", level: "corrected" });
  await ev("analysisExpl", "system", "analysis.created", { analysisId: anExpl.id }, { kind: "descriptive", level: "exploratory" });
  await ev("panelCreated", "director", "instrument.created", { instrumentId: instPanel.id }, { kind: "panel", constructId: construct.id });
  await ev("panelCompiled", "director", "instrument.compiled", { instrumentId: instPanel.id }, { versionHash: instPanel.versionHash, jurors: 3 });
  await ev("panelRunStarted", "human", "run.started", { runId: runPanel.id, instrumentId: instPanel.id, corpusId }, { model: runPanel.model, snapshot: null });
  await ev("panelRunCompleted", "system", "run.completed", { runId: runPanel.id }, { done: 12, total: 12, actualUSD: 0.06 });
  await ev("analysisPanel", "system", "analysis.created", { analysisId: anPanel.id, runId: runPanel.id, goldsetId: gsGold.id }, { kind: "crosstab", estimator: "dsl-proportion", level: "corrected" });

  return {
    root, projectDir, project, units, construct, inst, dict, run, gsGold, gsSilver,
    anDsl, anExpl, anPanel, instPanel, runPanel, aggPanel, jurorVotes,
    humanAgreement, machineAgreement, L,
    expected: { sales, ops, diff },
    expectedPanel: { sales: salesPanel, ops: opsPanel, diff: diffPanel },
  };
}

const F = await buildFixture();
after(() => rm(F.root, { recursive: true, force: true }));

const TOKEN_RE = /\[ledger:([0-9a-f]{8})\]/g;

function proseLines(md) {
  return md.split("\n").filter((l) => {
    const t = l.trim();
    return t.length > 0 && !t.startsWith("#") && !t.startsWith("|") && !t.startsWith(">") && !t.startsWith("-");
  });
}

// Minimal CSV parser for archive members KNOWN to contain no quoted fields
// (outputs/units CSVs, and gold CSVs built with includeGoldText: false).
function csvRows(text) {
  const [header, ...lines] = text.trim().split("\n").map((l) => l.split(","));
  return lines.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i]])));
}

// The exact estimator both generated reproduce scripts implement, replicated
// in JS: merge outputs rows with unit meta and gold (adjudicated, pi), form
// the DSL pseudo-outcome, take the per-cell mean and HC0 sandwich SE.
function dslFromCsv(outRows, unitById, goldById, dept) {
  const pseudo = [];
  for (const row of outRows) {
    if (unitById.get(row.unitId)?.meta_dept !== dept) continue;
    const yhat = Number(row.label);
    const g = goldById.get(row.unitId);
    pseudo.push(g && g.adjudicated !== "" ? yhat + (Number(g.adjudicated) - yhat) / Number(g.pi) : yhat);
  }
  const n = pseudo.length;
  const est = pseudo.reduce((a, b) => a + b, 0) / n;
  const se = Math.sqrt(pseudo.reduce((a, v) => a + (v - est) ** 2, 0) / n / n);
  return { est, se, n };
}

// ------------------------------------------------------------------ methods

test("methods: corrected analysis renders all eight numbered journal sections with the right facts", async () => {
  const { markdown } = await methods.generate(F.project, "an_dsl", { projectDir: F.projectDir });
  for (const h of [
    "## 1. Data and unitization",
    "## 2. Construct and codebook development",
    "## 3. Gold-standard sample",
    "## 4. Human reliability",
    "## 5. Instrument",
    "## 6. Calibration results",
    "## 7. Aggregation and run execution",
    "## 8. Statistical correction",
  ]) assert.ok(markdown.includes(h), `missing section heading: ${h}`);

  // data & unitization
  assert.ok(markdown.includes("exit.csv"));
  assert.ok(markdown.includes("12"));
  assert.ok(/response level/i.test(markdown));
  // construct authorship trail: Director-drafted, human-edited
  assert.ok(/drafted by the AI Director/.test(markdown));
  assert.ok(/edited by the research team/.test(markdown));
  // gold design with pi
  assert.ok(markdown.includes("n = 6"));
  assert.ok(markdown.includes("π = 0.500"));
  assert.ok(/simple random sample/i.test(markdown));
  assert.ok(/blind/i.test(markdown));
  // human reliability numbers (2 decimals, CI in brackets)
  const k2 = F.humanAgreement.kappa.toFixed(2);
  assert.ok(markdown.includes(k2), `human kappa ${k2} missing`);
  assert.ok(/\[-?\d+\.\d{2}, -?\d+\.\d{2}\]/.test(markdown), "CI brackets missing");
  // instrument facts
  assert.ok(markdown.includes("mock-judge-1@2026-05"));
  assert.ok(markdown.includes("temperature 0"));
  assert.ok(markdown.includes(F.inst.versionHash.slice(0, 12)));
  assert.ok(/replication archive/.test(markdown), "prompt-availability statement missing");
  assert.ok(/pinned/i.test(markdown));
  // silver tuning + stability appear in the instrument story
  assert.ok(/silver/i.test(markdown));
  assert.ok(markdown.includes("0.91"));
  // calibration certificate values inline
  assert.ok(markdown.includes(F.machineAgreement.kappa.toFixed(2)));
  assert.ok(markdown.includes("| Label |"), "per-class table missing");
  // correction: estimator named with the gold design + textual citations
  assert.ok(markdown.includes("Egami"));
  assert.ok(markdown.includes("Angelopoulos"));
  assert.ok(/design-based supervised learning/i.test(markdown));
  assert.ok(markdown.includes("◉"), "Corrected ladder mark missing");
  // headline corrected number at 3 decimals, with the naive companion SHOWN and different
  assert.ok(markdown.includes(F.expected.diff.est.toFixed(3)));
  assert.ok(markdown.includes(F.expected.diff.naive.est.toFixed(3)), "naive companion missing");
  assert.notEqual(F.expected.diff.est.toFixed(3), F.expected.diff.naive.est.toFixed(3), "fixture must exhibit a visible correction");
  // hygiene
  assert.ok(!/undefined|NaN|\bnull\b/.test(markdown), "placeholder leak in prose");
});

test("methods: every sentence carries a resolvable ledger citation and the export itself is ledgered", async () => {
  const { markdown, citations } = await methods.generate(F.project, "an_dsl", { projectDir: F.projectDir });

  // every sentence-final period must be immediately preceded by a citation token
  for (const line of proseLines(markdown)) {
    for (const m of line.matchAll(/\.(?=\s|$)/g)) {
      assert.equal(line[m.index - 1], "]", `unsourced sentence in line: ${line}`);
      const before = line.slice(0, m.index);
      assert.match(before, /\[ledger:[0-9a-f]{8}\]$/, `period not preceded by token: ${line}`);
    }
  }

  // every token resolves through citations to a real ledger event
  const tokens = [...markdown.matchAll(TOKEN_RE)].map((m) => m[1]);
  assert.ok(tokens.length >= 15, "suspiciously few citations");
  const events = await ledger.query(F.projectDir);
  const byHash = new Map(events.map((e) => [e.hash, e]));
  for (const t of new Set(tokens)) {
    const c = citations.find((c) => c.token === `ledger:${t}`);
    assert.ok(c, `token ${t} missing from citations`);
    assert.ok(c.hash.startsWith(t), "citation hash does not extend its token");
    const e = byHash.get(c.hash);
    assert.ok(e, `citation ${t} does not resolve to a ledger event`);
    assert.equal(e.type, c.type);
  }
  // citations are deduplicated, one entry per distinct token
  assert.equal(citations.length, new Set(tokens).size);

  // the export is itself ledgered and cited (object-state sentences resolve to it)
  const exports_ = events.filter((e) => e.type === "export.methods");
  assert.ok(exports_.length >= 1, "export.methods event missing");
  const cited = new Set(citations.map((c) => c.hash));
  assert.ok(exports_.some((e) => cited.has(e.hash)), "export.methods event not cited");

  // ledger chain still verifies after the export append
  const v = await ledger.verify(F.projectDir);
  assert.equal(v.ok, true);
});

test("methods: below-Corrected level renders its mark and the honest sentence", async () => {
  const { markdown } = await methods.generate(F.project, "an_expl", { projectDir: F.projectDir });
  assert.ok(markdown.includes("◌"), "Exploratory mark missing");
  assert.ok(markdown.includes("Estimates are exploratory; no human validation was performed"));
  assert.ok(markdown.includes("No statistical correction was applied"));
  assert.ok(!markdown.includes("Egami"), "must not cite DSL literature for an uncorrected analysis");
  assert.ok(!markdown.includes("## 8. Statistical correction"));
  // sentence-citation discipline holds here too
  for (const line of proseLines(markdown)) {
    for (const m of line.matchAll(/\.(?=\s|$)/g)) {
      assert.equal(line[m.index - 1], "]", `unsourced sentence in line: ${line}`);
    }
  }
});

test("methods: unknown analysis throws NOT_FOUND; bad args throw VALIDATION", async () => {
  await assert.rejects(methods.generate(F.project, "an_missing", { projectDir: F.projectDir }), (e) => e instanceof ConcordError && e.code === "NOT_FOUND");
  await assert.rejects(methods.generate(F.project, "an_dsl", {}), (e) => e instanceof ConcordError && e.code === "VALIDATION");
  await assert.rejects(methods.generate(null, "an_dsl", { projectDir: F.projectDir }), (e) => e instanceof ConcordError && e.code === "VALIDATION");
});

test("methods: a Corrected level without a correction estimator is refused at generate time", async () => {
  await assert.rejects(
    methods.generate(F.project, "an_bad", { projectDir: F.projectDir }),
    (e) => e instanceof ConcordError && e.code === "VALIDATION" && /correction estimator/.test(e.message)
  );
});

test("methods: stateHash commits to the full reported state tuple", async () => {
  const hashOf = async (project) => {
    await methods.generate(project, "an_dsl", { projectDir: F.projectDir });
    const evs = await ledger.query(F.projectDir, { type: "export.methods" });
    return evs[evs.length - 1].payload.stateHash;
  };
  const h1 = await hashOf(F.project);
  const h2 = await hashOf(F.project);
  assert.equal(h1, h2, "stateHash must be deterministic for identical state");

  const editedConstruct = structuredClone(F.project);
  editedConstruct.constructs[0].definition += " Amended after the fact.";
  const h3 = await hashOf(editedConstruct);
  assert.notEqual(h1, h3, "mutating the construct definition between exports must change the stateHash");

  const editedCert = structuredClone(F.project);
  editedCert.instruments[0].certificate.agreement.kappa = 0.123;
  const h4 = await hashOf(editedCert);
  assert.notEqual(h1, h4, "mutating the calibration certificate must change the stateHash");
});

test("methods: interpolated free text cannot end sentences or smuggle citation tokens", async () => {
  // the fixture definition is multi-sentence: internal terminators demote to
  // semicolons so the per-sentence citation check (run in the citation test)
  // holds; this pins the rendering
  const { markdown } = await methods.generate(F.project, "an_dsl", { projectDir: F.projectDir });
  assert.ok(
    markdown.includes("leaving; Includes raises and equity grievances; Excludes pay mentioned with no dissatisfaction link"),
    "internal sentence terminators in free text must become semicolons"
  );

  // fake tokens in free text are stripped, never laundered into citations
  const clone = structuredClone(F.project);
  clone.constructs[0].definition = "Pay complaints. Evil token [ledger:deadbeef] inside! Trailing question? Done.";
  const m2 = await methods.generate(clone, "an_dsl", { projectDir: F.projectDir });
  assert.ok(!m2.markdown.includes("deadbeef"), "fake citation token must be stripped from interpolated text");
  assert.ok(m2.markdown.includes("Pay complaints; Evil token inside; Trailing question; Done"));
  assert.ok(!m2.citations.some((c) => c.token.includes("deadbeef")), "fake token must not enter the citation table");
  for (const line of proseLines(m2.markdown)) {
    for (const m of line.matchAll(/\.(?=\s|$)/g)) {
      assert.equal(line[m.index - 1], "]", `unsourced sentence in line: ${line}`);
    }
  }
});

test("methods: overclaimed sentences are conditioned on recorded evidence", async () => {
  const { markdown } = await methods.generate(F.project, "an_dsl", { projectDir: F.projectDir });
  // (a) fixture ledger proves agreement preceded machine comparison -> strong claim allowed
  assert.ok(markdown.includes("before any machine output was compared"), "order-proven reliability sentence missing");
  // (b) blindness states exactly what the coder flags record
  assert.ok(markdown.includes("blind to machine labels and to each other's labels"), "honest blindness phrasing missing");
  assert.ok(!/enforced by the serving role/.test(markdown), "blindness-enforcement overclaim must be gone");
  // (c) the fixture run escalated 1 unit: no exactly-one claim; escalation described
  assert.ok(!markdown.includes("exactly one machine judgment"), "exactly-one claim despite escalations");
  assert.ok(/1 unit was escalated/.test(markdown), "escalation sentence (count) missing");
  assert.ok(/Director model \(not recorded\)/.test(markdown), "null Director model must render as not recorded");
  // (d) pinning is the run's recorded fact
  assert.ok(markdown.includes("pinned for every call in this run"), "run.pinned=true sentence missing");
  // (e) all three codebook slots present in the fixture template -> verbatim claim earned
  assert.ok(markdown.includes("injected into the prompt verbatim"), "verbatim claim missing despite full slots");
  // (f) frozen instrument -> "As frozen" is earned here
  assert.ok(markdown.includes("As frozen for this analysis"), "frozen wording missing for frozen instrument");
  // author list and availability phrasing
  assert.ok(markdown.includes("Egami, Hinck, Stewart, and Wei"), "corrected author list missing");
  assert.ok(!markdown.includes("Jacobs-Harukawa"));
  assert.ok(markdown.includes("available in the replication archive export"), "availability phrasing missing");
  assert.ok(!/published verbatim in the replication archive/.test(markdown), "publication overclaim must be gone");

  // (e) counterfactual: template missing a slot -> no verbatim claim
  const noSlots = structuredClone(F.project);
  noSlots.instruments[0].payload.promptTemplate = "Coder.\n{{definition}}\n{{criteria}}\nUnit:\n{{unit}}\nReturn JSON.";
  const m2 = await methods.generate(noSlots, "an_dsl", { projectDir: F.projectDir });
  assert.ok(!m2.markdown.includes("verbatim"), "verbatim claim without all three slots");

  // (f) counterfactual: unfrozen instrument -> export-time wording
  const unfrozen = structuredClone(F.project);
  unfrozen.instruments[0].frozen = false;
  delete unfrozen.instruments[0].certificate;
  const m3 = await methods.generate(unfrozen, "an_dsl", { projectDir: F.projectDir });
  assert.ok(m3.markdown.includes("As recorded at export time"), "unfrozen instrument must use export-time wording");
  assert.ok(!m3.markdown.includes("As frozen for this analysis"));
});

test("methods: unrecorded execution facts render as not recorded, never as confident defaults", async () => {
  // missing decoding params
  const clone = structuredClone(F.project);
  delete clone.instruments[0].payload.params.temperature;
  delete clone.instruments[0].payload.params.maxTokens;
  const m1 = await methods.generate(clone, "an_dsl", { projectDir: F.projectDir });
  assert.ok(/temperature that was not recorded/.test(m1.markdown), "missing temperature must render as not recorded");
  assert.ok(!/temperature 0\b/.test(m1.markdown), "missing temperature must not default to 0");
  assert.ok(/output-token maximum that was not recorded/.test(m1.markdown), "missing maxTokens must render as not recorded");

  // a run that recorded neither cost nor checkpoint nor escalation
  const bareRun = {
    id: "run_nocost", instrumentId: F.inst.id, versionHash: F.inst.versionHash,
    corpusId: "corp_demo", status: "complete", provider: "mock",
    model: "mock-judge-1", snapshot: "mock-judge-1@2026-05",
  };
  await mkdir(path.join(F.projectDir, "runs", "run_nocost"), { recursive: true });
  await writeFile(path.join(F.projectDir, "runs", "run_nocost", "run.json"), JSON.stringify(bareRun, null, 2), "utf8");
  const anNocost = structuredClone(F.anDsl);
  anNocost.id = "an_nocost";
  anNocost.spec = { ...anNocost.spec, runId: "run_nocost" };
  await writeFile(path.join(F.projectDir, "analyses", "an_nocost.json"), JSON.stringify(anNocost, null, 2), "utf8");
  const m2 = await methods.generate(F.project, "an_nocost", { projectDir: F.projectDir });
  assert.ok(/no metered cost recorded/.test(m2.markdown), "absent cost must render as not recorded");
  assert.ok(!/\$0\.00/.test(m2.markdown), "absent cost must not print as $0.00");
  assert.ok(/completion counts not recorded/.test(m2.markdown), "absent checkpoint must render as not recorded");
  assert.ok(!m2.markdown.includes("exactly one machine judgment"), "exactly-one claim without a recorded escalation count");
  assert.ok(!/pinned for every call/.test(m2.markdown), "unpinned run must not claim pinning");
});

test("methods: panel analysis describes jurors, aggregation and pinning honestly", async () => {
  const { markdown } = await methods.generate(F.project, "an_panel", { projectDir: F.projectDir });
  assert.ok(/panel of 3 LLM jurors/.test(markdown), "panel head sentence missing");
  for (const m of ["mock-a", "mock-b", "mock-c"]) assert.ok(markdown.includes(m), `juror model ${m} missing`);
  assert.ok(!/disjoint model families/.test(markdown), "unverifiable model-family claim must be gone");
  // heterogeneous juror params -> no single shared decoding claim
  assert.ok(/Decoding parameters varied across jurors/.test(markdown), "varied-params sentence missing");
  assert.ok(!/Decoding used temperature/.test(markdown), "must not assert one temperature for heterogeneous jurors");
  // aggregation rule as recorded; escalation count 0 on this run
  assert.ok(/majority rule/.test(markdown), "aggregation rule missing");
  // run.pinned = false -> limitation sentence instead of the pinned claim
  assert.ok(!/pinned for every call/.test(markdown), "pinned claim on an unpinned run");
  assert.ok(/did not pin a model snapshot/.test(markdown), "unpinned limitation sentence missing");
  // corrected numbers and ladder mark present
  assert.ok(markdown.includes(F.expectedPanel.diff.est.toFixed(3)), "panel corrected diff missing");
  assert.ok(markdown.includes("◉"));
  // citation discipline holds on the panel page too
  for (const line of proseLines(markdown)) {
    for (const m of line.matchAll(/\.(?=\s|$)/g)) {
      assert.equal(line[m.index - 1], "]", `unsourced sentence in line: ${line}`);
    }
  }

  // unrecorded aggregation rule says so instead of defaulting to majority
  const clone = structuredClone(F.project);
  delete clone.instruments.find((i) => i.id === "inst_panel").payload.aggregation;
  const m2 = await methods.generate(clone, "an_panel", { projectDir: F.projectDir });
  assert.ok(/aggregation rule was not recorded/.test(m2.markdown), "missing aggregation rule must render as not recorded");
  assert.ok(!/majority rule/.test(m2.markdown), "missing aggregation rule must not default to majority");
});

// -------------------------------------------------------------- replication

test("replication: archive contains every member, sorted, and MANIFEST hashes verify", async () => {
  const { zipBuffer, manifest } = await replication.build(F.project, ["an_dsl", "an_expl"], { projectDir: F.projectDir });
  const files = unzipSync(new Uint8Array(zipBuffer));
  const paths = Object.keys(files);
  for (const p of [
    "MANIFEST.json", "README.md", "agreement.json", "analyses/an_dsl.json", "analyses/an_expl.json",
    "codebook.md", "dictionaries/inst_dict.json", "gold/gs_gold.csv", "gold/gs_silver.csv",
    "instruments/inst_judge.json", "outputs/run_1.csv", "reproduce.R", "reproduce.py", "units/corp_demo.csv",
  ]) assert.ok(paths.includes(p), `archive missing member: ${p}`);
  assert.deepEqual(paths, [...paths].sort(), "zip member order must be sorted");

  // MANIFEST covers every member except itself, with correct sha256
  const parsed = JSON.parse(strFromU8(files["MANIFEST.json"]));
  assert.deepEqual(Object.keys(parsed.files).sort(), paths.filter((p) => p !== "MANIFEST.json").sort());
  for (const [p, h] of Object.entries(parsed.files)) {
    assert.equal(sha256(strFromU8(files[p])), h, `manifest hash mismatch for ${p}`);
  }
  assert.equal(parsed.createdAt, F.project.createdAt, "manifest timestamps must come from the project, not now");
  assert.deepEqual(manifest.files, parsed.files);

  // instruments/ JSON carries the FULL frozen payload including the prompt
  const instJson = JSON.parse(strFromU8(files["instruments/inst_judge.json"]));
  assert.equal(instJson.payload.promptTemplate, F.inst.payload.promptTemplate);
  assert.equal(instJson.versionHash, F.inst.versionHash);
  const dictJson = JSON.parse(strFromU8(files["dictionaries/inst_dict.json"]));
  assert.ok(dictJson.payload.categories[0].terms.length >= 4);

  // agreement.json has the certificate stats
  const agr = JSON.parse(strFromU8(files["agreement.json"]));
  const certInst = agr.instruments.find((i) => i.id === "inst_judge");
  assert.equal(certInst.certificate.agreement.kappa, F.machineAgreement.kappa);
  assert.equal(certInst.certificate.humanAgreement.kappa, F.humanAgreement.kappa);

  // ledger event with the manifest hash
  const events = await ledger.query(F.projectDir, { type: "export.replication" });
  assert.ok(events.length >= 1);
  assert.equal(events[events.length - 1].payload.manifestHash, sha256(strFromU8(files["MANIFEST.json"])));
});

test("replication: gold CSV has pi, per-coder labels, adjudicated; text only when includeGoldText; escaping correct", async () => {
  const { zipBuffer } = await replication.build(F.project, ["an_dsl"], { projectDir: F.projectDir });
  const files = unzipSync(new Uint8Array(zipBuffer));
  const csv = strFromU8(files["gold/gs_gold.csv"]);
  assert.ok(csv.startsWith("unitId,pi,label_coder_a,label_coder_b,adjudicated,text\n"), `gold csv header wrong: ${csv.split("\n")[0]}`);
  assert.ok(csv.includes("0.5"), "pi missing");
  // u4's text round-trips with RFC-4180 escaping: doubled quotes, embedded newline inside one quoted field
  assert.ok(csv.includes('"She said ""I quit"", then left.\nSecond line about salary."'), "CSV escaping of quotes/newline broken");

  const noText = await replication.build(F.project, ["an_dsl"], { projectDir: F.projectDir, includeGoldText: false });
  const csv2 = strFromU8(unzipSync(new Uint8Array(noText.zipBuffer))["gold/gs_gold.csv"]);
  assert.ok(csv2.startsWith("unitId,pi,label_coder_a,label_coder_b,adjudicated\n"));
  assert.ok(!csv2.includes("I quit"), "unit text leaked despite includeGoldText: false");

  // outputs CSV columns per contract
  const out = strFromU8(files["outputs/run_1.csv"]);
  assert.equal(out.split("\n")[0], "unitId,label,confidence,escalated,cacheHit");
  assert.equal(out.trim().split("\n").length, 13, "12 output rows + header");
  assert.ok(out.includes("true"), "escalated/cacheHit flags missing");
});

test("replication: deterministic — two builds produce byte-identical zips", async () => {
  const a = await replication.build(F.project, ["an_dsl", "an_expl"], { projectDir: F.projectDir });
  const b = await replication.build(F.project, ["an_dsl", "an_expl"], { projectDir: F.projectDir });
  assert.ok(Buffer.from(a.zipBuffer).equals(Buffer.from(b.zipBuffer)), "zip bytes differ across rebuilds");
});

test("replication: reproduce.py embeds Concord's exact stored numbers and the DSL estimator", async () => {
  const { zipBuffer } = await replication.build(F.project, ["an_dsl"], { projectDir: F.projectDir });
  const py = strFromU8(unzipSync(new Uint8Array(zipBuffer))["reproduce.py"]);
  for (const x of [
    F.expected.sales.est, F.expected.sales.se,
    F.expected.ops.est, F.expected.ops.se,
    F.expected.diff.est, F.expected.diff.se,
  ]) assert.ok(py.includes(String(x)), `expected number ${x} not embedded in reproduce.py`);
  assert.ok(py.includes("1e-6"), "tolerance assertion missing");
  assert.ok(/pseudo/.test(py) && /pi/.test(py), "pseudo-outcome estimator missing");
  assert.ok(py.includes("import numpy") && py.includes("import pandas"), "numpy/pandas imports missing");
  assert.ok(py.includes("assert"), "reproduce.py must assert equality");
  assert.ok(py.includes('read_csv("outputs/run_1.csv")'));
  assert.ok(py.includes('read_csv("gold/gs_gold.csv")'));
});

test("replication: reproduce.R targets the dsl package and references only columns that exist", async () => {
  const { zipBuffer } = await replication.build(F.project, ["an_dsl"], { projectDir: F.projectDir });
  const files = unzipSync(new Uint8Array(zipBuffer));
  const r = strFromU8(files["reproduce.R"]);
  assert.ok(r.includes("library(dsl)"));
  assert.ok(/dsl\(\s*model\s*=\s*"lm"/.test(r), "dsl() call missing");
  assert.ok(r.includes('sample_prob = "pi"'), "dsl() must use the recorded inclusion probabilities");
  assert.ok(r.includes('read.csv("outputs/run_1.csv"'));
  assert.ok(r.includes('read.csv("gold/gs_gold.csv"'));
  assert.ok(r.includes('read.csv("units/corp_demo.csv"'));
  assert.ok(r.includes(F.expected.sales.est.toFixed(6)), "Concord's number missing from R comments");

  // every column the script references (d$col, d[["col"]], `col` in formulas)
  // must be a CSV column or assigned in the script; comments are excluded so
  // backticked prose (package names) is not misread as a column.
  const headers = new Set(
    ["outputs/run_1.csv", "gold/gs_gold.csv", "units/corp_demo.csv"]
      .flatMap((p) => strFromU8(files[p]).split("\n")[0].split(","))
  );
  const code = r.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  const assigned = new Set([...code.matchAll(/\w+\$(\w+)\s*(?:\[[^\]]*\]\s*)?<-/g)].map((m) => m[1]));
  const refs = [
    ...[...code.matchAll(/\w+\$([A-Za-z_][\w.]*)/g)].map((m) => m[1]),
    ...[...code.matchAll(/\w+\[\["([^"]+)"\]\]/g)].map((m) => m[1]),
    ...[...code.matchAll(/`([^`]+)`/g)].map((m) => m[1]),
  ];
  for (const col of refs) {
    assert.ok(headers.has(col) || assigned.has(col), `reproduce.R references unknown column: ${col}`);
  }
  // the grouping column the formula uses exists in units csv (meta_ prefixed)
  assert.ok(headers.has("meta_dept"));
});

test("replication: panel runs — scripts filter to the aggregate verdicts and the embedded numbers reproduce", async () => {
  const { zipBuffer } = await replication.build(F.project, ["an_panel"], { projectDir: F.projectDir, includeGoldText: false });
  const files = unzipSync(new Uint8Array(zipBuffer));

  // outputs CSV keeps every row (3 jurors + the aggregate verdict per unit)
  const outCsv = strFromU8(files["outputs/run_panel.csv"]);
  assert.equal(outCsv.split("\n")[0], "unitId,label,confidence,escalated,cacheHit,juror");
  assert.equal(outCsv.trim().split("\n").length, 1 + 12 * 4, "12 units x (3 jurors + aggregate)");

  // both generated scripts mask to juror == "aggregate" BEFORE merging
  const py = strFromU8(files["reproduce.py"]);
  const r = strFromU8(files["reproduce.R"]);
  assert.ok(py.includes('if "juror" in outputs.columns:'), "py juror mask missing");
  assert.ok(py.includes('outputs = outputs[outputs["juror"] == "aggregate"]'), "py aggregate filter missing");
  assert.ok(r.includes('if ("juror" %in% names(outputs)) outputs <- subset(outputs, juror == "aggregate")'), "R aggregate filter missing");

  // embedded numbers equal Concord's stored results for the panel analysis
  for (const x of [
    F.expectedPanel.sales.est, F.expectedPanel.sales.se,
    F.expectedPanel.ops.est, F.expectedPanel.ops.se,
    F.expectedPanel.diff.est, F.expectedPanel.diff.se,
  ]) assert.ok(py.includes(String(x)), `panel number ${x} not embedded in reproduce.py`);

  // JS recomputation of the scripts' logic from the archive CSVs: with the
  // aggregate mask the numbers match the embedded ones exactly; without it
  // (the duplicated-merge bug) they are materially wrong.
  const allRows = csvRows(outCsv);
  const aggRows = allRows.filter((row) => row.juror === "aggregate");
  const unitById = new Map(csvRows(strFromU8(files["units/corp_demo.csv"])).map((u) => [u.unitId, u]));
  const goldById = new Map(csvRows(strFromU8(files["gold/gs_gold.csv"])).map((g) => [g.unitId, g]));
  const embedded = Object.fromEntries(
    [...py.matchAll(/\("(ops|sales)", ([-0-9.e]+), ([-0-9.e]+)\)/g)].map((m) => [m[1], { est: Number(m[2]), se: Number(m[3]) }])
  );
  assert.deepEqual(Object.keys(embedded).sort(), ["ops", "sales"], "panel cell tuples missing from reproduce.py");
  for (const dept of ["ops", "sales"]) {
    const good = dslFromCsv(aggRows, unitById, goldById, dept);
    assert.equal(good.n, 6, "aggregate mask must leave exactly one row per unit");
    assert.ok(Math.abs(good.est - embedded[dept].est) < 1e-12, `${dept} est: recomputed ${good.est} != embedded ${embedded[dept].est}`);
    assert.ok(Math.abs(good.se - embedded[dept].se) < 1e-12, `${dept} se: recomputed ${good.se} != embedded ${embedded[dept].se}`);
    const bad = dslFromCsv(allRows, unitById, goldById, dept);
    assert.equal(bad.n, 24, "unfiltered merge duplicates every unit");
    assert.ok(Math.abs(bad.est - embedded[dept].est) > 1e-3, `fixture must make the unfiltered ${dept} estimate visibly wrong`);
  }
});

test("replication: units CSV prefixes meta columns and neutralizes formula injection", async () => {
  const { zipBuffer } = await replication.build(F.project, ["an_dsl"], { projectDir: F.projectDir });
  const files = unzipSync(new Uint8Array(zipBuffer));
  const unitsCsv = strFromU8(files["units/corp_demo.csv"]);
  // meta keys are prefixed so they can never collide with unitId/label/pi/adjudicated on merge
  assert.equal(unitsCsv.split("\n")[0], "unitId,meta_dept,meta_note,meta_satisfaction");
  // a meta value starting with "=" carries the documented apostrophe prefix
  assert.ok(unitsCsv.includes("'=2+5"), "formula-injection prefix missing on =-leading cell");
  assert.ok(!/(^|,)=/m.test(unitsCsv), "raw leading = leaked into a CSV cell");
  // convention: strings starting with = + - @ get a leading apostrophe; numbers never do
  assert.equal(replication.csvField("=SUM(A1)"), "'=SUM(A1)");
  assert.equal(replication.csvField("@cmd"), "'@cmd");
  assert.equal(replication.csvField("+1 thing"), "'+1 thing");
  assert.equal(replication.csvField("-rf tmp"), "'-rf tmp");
  assert.equal(replication.csvField(-0.5), "-0.5");
  assert.equal(replication.csvField(2), "2");
  assert.equal(replication.csvField(true), "true");
  // README documents both conventions
  const readme = strFromU8(files["README.md"]);
  assert.ok(readme.includes("meta_"), "meta_ prefix convention undocumented");
  assert.ok(/formula injection|spreadsheet formula/i.test(readme), "injection convention undocumented");
});

test("replication: reproduce.R verifies inline with stopifnot and demotes dsl() to a labeled cross-check", async () => {
  const { zipBuffer } = await replication.build(F.project, ["an_dsl"], { projectDir: F.projectDir });
  const files = unzipSync(new Uint8Array(zipBuffer));
  const r = strFromU8(files["reproduce.R"]);
  const py = strFromU8(files["reproduce.py"]);

  // primary verification: pseudo-outcome estimator computed INLINE in R,
  // asserted near-equal to Concord's stored numbers
  assert.ok(r.includes("pseudo"), "inline pseudo-outcome estimator missing from R");
  assert.ok(/stopifnot\(abs\(/.test(r), "stopifnot near-equality assertions missing");
  assert.ok(r.includes("1e-6"), "R tolerance missing");
  assert.ok(r.includes(String(F.expected.sales.est)), "Concord's full-precision number missing from R assertions");
  assert.ok(r.includes(String(F.expected.diff.se)), "diff SE missing from R assertions");

  // dsl() remains as a clearly labeled methodological cross-check that cannot
  // abort the verification and warns about precision and tiny gold samples
  assert.ok(/CROSS-CHECK/.test(r), "cross-check label missing");
  assert.ok(/will not match/i.test(r), "printed-precision caveat missing");
  assert.ok(/may fail/i.test(r), "tiny-gold-sample caveat missing");
  assert.ok(r.includes("set.seed("), "pinned seed for the cross-check missing");
  assert.ok(/tryCatch\(/.test(r), "cross-check must be wrapped so failure cannot abort verification");
  assert.ok(/dsl\(\s*model\s*=\s*"lm"/.test(r), "dsl() call missing");

  // reference-level comment states the actual contrast direction
  assert.ok(/alphabetically first/i.test(r), "reference-level explanation missing");
  assert.ok(!/read the difference as a slope/.test(r), "old sign-flip-prone comment must be gone");

  // author list corrected in BOTH scripts
  assert.ok(r.includes("Egami, Hinck, Stewart, and Wei"), "R author list wrong");
  assert.ok(!r.includes("Jacobs-Harukawa"), "R must not carry the wrong surname");
  assert.ok(py.includes("Egami, Hinck, Stewart, and Wei"), "py author list wrong");
  assert.ok(!py.includes("Jacobs-Harukawa"), "py must not carry the wrong surname");

  // merge-collision guard: both scripts reference the prefixed meta column
  assert.ok(r.includes("meta_dept"), "R must reference the prefixed meta column");
  assert.ok(py.includes('"meta_dept"'), "py must reference the prefixed meta column");
});

test("replication: unknown analysis id throws NOT_FOUND; bad args throw VALIDATION", async () => {
  await assert.rejects(replication.build(F.project, ["an_missing"], { projectDir: F.projectDir }), (e) => e instanceof ConcordError && e.code === "NOT_FOUND");
  await assert.rejects(replication.build(F.project, [], { projectDir: F.projectDir }), (e) => e instanceof ConcordError && e.code === "VALIDATION");
  await assert.rejects(replication.build(F.project, ["an_dsl"], {}), (e) => e instanceof ConcordError && e.code === "VALIDATION");
});

// ------------------------------------------------------------------ report

test("report: standalone HTML — self-contained, well-formed, drill-down JSON, marks, print CSS", async () => {
  const layout = [
    { kind: "text", content: "Corrected prevalence of pay concerns by department." },
    { kind: "chart", ref: "an_dsl" },
    { kind: "table", ref: "an_dsl" },
    { kind: "quote", ref: F.units[4].id },
    { kind: "methods-excerpt", ref: "an_dsl" },
  ];
  const html = await report.render(F.project, layout, { projectDir: F.projectDir });

  assert.ok(html.startsWith("<!DOCTYPE html>"));
  for (const tag of ["html", "head", "body", "main", "style", "div", "section", "svg", "table", "blockquote", "script"]) {
    const open = (html.match(new RegExp(`<${tag}[\\s>]`, "g")) || []).length;
    const close = (html.match(new RegExp(`</${tag}>`, "g")) || []).length;
    assert.equal(open, close, `unbalanced <${tag}>: ${open} open vs ${close} close`);
  }

  // self-contained: no external RESOURCE references. Asserting on src=/href=/
  // url( rather than bare "http" — prose and quoted unit text may legitimately
  // mention URLs without the file fetching anything.
  assert.ok(!/\b(?:src|href)\s*=\s*["']?\s*https?:/i.test(html), "external src/href found in report HTML");
  assert.ok(!/url\(\s*["']?\s*https?:/i.test(html), "external url() found in report CSS");

  // drill-down: embedded evidence JSON parses and carries real unit text
  const m = html.match(/<script type="application\/json" id="concord-evidence">([\s\S]*?)<\/script>/);
  assert.ok(m, "embedded evidence JSON missing");
  const data = JSON.parse(m[1]);
  assert.ok(data.evidence.sales.length >= 1);
  assert.ok(data.evidence.sales.some((e) => typeof e.text === "string" && e.text.length > 0));
  assert.ok(data.evidence.sales.some((e) => e.label !== undefined), "evidence entries must carry machine labels");
  assert.ok(html.includes('data-evidence="sales"') && html.includes('data-evidence="ops"'));
  assert.ok(html.includes("addEventListener"), "drill-down script missing");

  // ladder marks beside numbers; corrected + naive (hatched) rendering
  assert.ok(html.includes("◉"));
  assert.ok(html.includes("0.83") && html.includes("0.33"), "corrected estimates missing");
  assert.ok(html.includes("0.50 uncorrected"), "naive bar label missing");
  assert.ok(html.includes("<pattern") && html.includes("url(#"), "hatch pattern for uncorrected values missing");

  // fonts: family stacks only, no embedded font files or @font-face
  assert.ok(html.includes("Fraunces") && html.includes("IBM Plex Sans"));
  assert.ok(!html.includes("@font-face"), "fonts must not be embedded");
  // reading-room palette
  assert.ok(html.includes("#FAF7F2") && html.includes("#1A1815") && html.includes("#1F6F6B"));

  // print stylesheet
  assert.ok(html.includes("@media print"));

  // quote block renders the unit verbatim (HTML-escaped)
  assert.ok(html.includes("I quit"));
  // u1's "<b>" never appears raw anywhere (escaped in markup AND in JSON)
  assert.ok(!html.includes("<b>bold claim</b>"), "unit text not HTML-escaped");

  // methods excerpt embedded with citation chips
  assert.ok(html.includes("Methods"));
  assert.ok(/ledger:[0-9a-f]{8}/.test(html), "citation chips missing from methods excerpt");

  // hygiene
  assert.ok(!/undefined|NaN/.test(html), "placeholder leak in HTML");
});

test("report: methods-excerpt is a side-effect-free preview by default", async () => {
  const countExports = async () => (await ledger.query(F.projectDir, { type: "export.methods" })).length;

  const before = await countExports();
  const html = await report.render(F.project, [{ kind: "methods-excerpt", ref: "an_dsl" }], { projectDir: F.projectDir });
  assert.equal(await countExports(), before, "default render must not append export.methods events");
  assert.ok(html.includes("Preview — not an export of record"), "preview banner missing");
  assert.ok(/ledger:[0-9a-f]{8}/.test(html), "preview citations must still render as chips");

  // preview citations resolve against EXISTING events only
  const prev = await methods.generatePreview(F.project, "an_dsl", { projectDir: F.projectDir });
  assert.equal(await countExports(), before, "generatePreview must not append");
  assert.ok(prev.markdown.includes("> Preview — not an export of record"), "preview markdown banner missing");
  const events = await ledger.query(F.projectDir);
  const byHash = new Map(events.map((e) => [e.hash, e]));
  for (const c of prev.citations) {
    assert.ok(byHash.has(c.hash), `preview citation ${c.token} does not resolve to an existing event`);
  }

  // a real export of record stays available per block
  const html2 = await report.render(F.project, [{ kind: "methods-excerpt", ref: "an_dsl", sideEffectFree: false }], { projectDir: F.projectDir });
  assert.equal(await countExports(), before + 1, "sideEffectFree: false must perform an export of record");
  assert.ok(!html2.includes("Preview — not an export of record"), "export of record must not carry the preview banner");

  // the chain stays valid throughout
  assert.equal((await ledger.verify(F.projectDir)).ok, true);
});

test("report: watermark band present iff any block is exploratory", async () => {
  const noExpl = await report.render(F.project, [{ kind: "chart", ref: "an_dsl" }], { projectDir: F.projectDir });
  assert.ok(!noExpl.includes("watermark"), "watermark must be absent without exploratory blocks");

  const withExpl = await report.render(F.project, [
    { kind: "chart", ref: "an_dsl" },
    { kind: "chart", ref: "an_expl" },
  ], { projectDir: F.projectDir });
  assert.ok(withExpl.includes("watermark"), "watermark band missing");
  assert.ok(/EXPLORATORY/i.test(withExpl), "watermark must say exploratory");
  assert.ok(withExpl.includes("◌"), "exploratory mark missing");
});

test("report: inline-content chart, table and quote blocks render without an analysis ref", async () => {
  const html = await report.render(F.project, [
    { kind: "chart", content: { title: "Custom chart", level: "calibrated", bars: [{ label: "a", value: 0.4, n: 10 }, { label: "b", value: 0.7, ci: { lo: 0.5, hi: 0.9 } }] } },
    { kind: "table", content: { title: "Custom table", columns: ["x", "y"], rows: [["1", "2"]] } },
    { kind: "quote", content: { text: "Inline quote from fieldnotes", attribution: "fieldnote-3" } },
  ], { projectDir: F.projectDir });
  assert.ok(html.includes("Custom chart") && html.includes("●"), "calibrated mark missing");
  assert.ok(html.includes("url(#"), "below-Corrected content must render hatched");
  assert.ok(html.includes("<th>x</th>") && html.includes("<td>1</td>"));
  assert.ok(html.includes("Inline quote from fieldnotes") && html.includes("fieldnote-3"));
  assert.ok(!html.includes("watermark"), "calibrated content must not trigger the watermark");
});

test("report: bad layout throws VALIDATION; unknown refs throw NOT_FOUND", async () => {
  await assert.rejects(report.render(F.project, "not-an-array", { projectDir: F.projectDir }), (e) => e instanceof ConcordError && e.code === "VALIDATION");
  await assert.rejects(report.render(F.project, [{ kind: "hologram" }], { projectDir: F.projectDir }), (e) => e instanceof ConcordError && e.code === "VALIDATION");
  await assert.rejects(report.render(F.project, [{ kind: "chart", ref: "an_missing" }], { projectDir: F.projectDir }), (e) => e instanceof ConcordError && e.code === "NOT_FOUND");
  await assert.rejects(report.render(F.project, [{ kind: "chart" }], { projectDir: F.projectDir }), (e) => e instanceof ConcordError && e.code === "VALIDATION");
});

test("methods: uncodable + excluded counts render one reliability sentence, only when nonzero", async () => {
  // the untouched fixture has no uncodable marks and no exclusions → silent
  const clean = await methods.generate(F.project, "an_dsl", { projectDir: F.projectDir });
  assert.ok(!/uncodable/.test(clean.markdown), "no uncodable claim without uncodable marks");
  assert.ok(!/excluded from the gold standard/.test(clean.markdown), "no exclusion claim without exclusions");

  // two units carry an uncodable mark from ≥1 coder (one overlaps across
  // coders and must not double-count); one unit was excluded from gold at
  // adjudication. The mutation deliberately stays in place: the final
  // reliability-downgrade test re-runs the per-sentence citation check over
  // this prose.
  const goldFile = path.join(F.projectDir, "gold", "gs_gold.json");
  const gs = JSON.parse(await readFile(goldFile, "utf8"));
  const [u0, u1, u2] = gs.sample.map((s) => s.unitId);
  gs.coders[0].uncodable = { [u0]: true, [u1]: true };
  gs.coders[1].uncodable = { [u0]: true };
  gs.excluded = [u2];
  await writeFile(goldFile, JSON.stringify(gs, null, 2), "utf8");

  const { markdown } = await methods.generate(F.project, "an_dsl", { projectDir: F.projectDir });
  const reliability = markdown.split("## 4. Human reliability")[1]?.split("\n## ")[0] ?? "";
  assert.match(reliability,
    /2 units were marked uncodable by at least one coder; 1 unit was excluded from the gold standard after adjudication \[ledger:[0-9a-f]{8}\]\./,
    "the factual disclosure sentence with correct counts belongs to the reliability section");
});

// LAST because it appends a ledger event that changes what the generator may
// claim for every later generate() in this fixture.
test("methods: reliability-order claim downgrades when the ledger cannot prove it", async () => {
  // a recomputed agreement event AFTER the freeze/analysis events means the
  // latest reliability computation postdates machine comparison — the strong
  // "before any machine output" sentence is no longer provable
  await ledger.append(F.projectDir, "system", "goldset.agreement", { goldsetId: F.gsGold.id }, {
    n: 6, percent: F.humanAgreement.percent, kappa: F.humanAgreement.kappa,
    alpha: F.humanAgreement.alpha, recomputed: true,
  });
  const { markdown } = await methods.generate(F.project, "an_dsl", { projectDir: F.projectDir });
  assert.ok(!markdown.includes("before any machine output was compared"), "strong order claim without ledger proof");
  assert.ok(/Inter-coder reliability was computed from the blind double-coded sample/.test(markdown), "fallback reliability sentence missing");
  for (const line of proseLines(markdown)) {
    for (const m of line.matchAll(/\.(?=\s|$)/g)) {
      assert.equal(line[m.index - 1], "]", `unsourced sentence in line: ${line}`);
    }
  }
});

// Opt-in artifact dump for human review (never runs in CI):
//   CONCORD_REPORTING_DUMP=<dir> node --test tests/unit/reporting.test.js
test("artifact dump for manual review", { skip: !process.env.CONCORD_REPORTING_DUMP }, async () => {
  const dir = process.env.CONCORD_REPORTING_DUMP;
  await mkdir(dir, { recursive: true });
  const m = await methods.generate(F.project, "an_dsl", { projectDir: F.projectDir });
  await writeFile(path.join(dir, "methods-an_dsl.md"), m.markdown, "utf8");
  const m2 = await methods.generate(F.project, "an_expl", { projectDir: F.projectDir });
  await writeFile(path.join(dir, "methods-an_expl.md"), m2.markdown, "utf8");
  const { zipBuffer } = await replication.build(F.project, ["an_dsl", "an_expl"], { projectDir: F.projectDir });
  await writeFile(path.join(dir, "replication.zip"), zipBuffer);
  for (const [p, bytes] of Object.entries(unzipSync(new Uint8Array(zipBuffer)))) {
    const target = path.join(dir, "archive", p);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(bytes));
  }
  const html = await report.render(F.project, [
    { kind: "text", content: "Corrected prevalence of pay concerns by department." },
    { kind: "chart", ref: "an_dsl" },
    { kind: "table", ref: "an_dsl" },
    { kind: "chart", ref: "an_expl" },
    { kind: "quote", ref: F.units[4].id },
    { kind: "methods-excerpt", ref: "an_dsl" },
  ], { projectDir: F.projectDir });
  await writeFile(path.join(dir, "report.html"), html, "utf8");
});
