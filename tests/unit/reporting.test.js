// Reporting layer tests: methods generator, replication archive, report canvas.
//
// The fixture is a REAL project bundle built programmatically in a temp dir
// with the Wave-1 core modules (objects/store/ledger) and real statistics
// (agreement/correction), so every number the reporting layer cites is a
// number Concord actually computed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
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
    meta: { dept: depts[i], satisfaction: (i % 5) + 1 },
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

  // ---- construct (Director-drafted, human-edited)
  const construct = createConstruct({
    id: "c_pay",
    name: "Pay concern",
    type: "binary",
    definition: "Mentions of compensation, salary, bonus or pay fairness as a stated reason for dissatisfaction or leaving",
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
    instruments: [inst, dict],
    goldsets: [
      { id: gsSilver.id, constructId: construct.id, tier: "silver", design: "srs", status: "complete", n: gsSilver.sample.length },
      { id: gsGold.id, constructId: construct.id, tier: "gold", design: "srs", status: "complete", n: gsGold.sample.length },
    ],
    analyses: [
      { id: anDsl.id, kind: anDsl.kind, level: anDsl.level, createdAt: anDsl.createdAt },
      { id: anExpl.id, kind: anExpl.kind, level: anExpl.level, createdAt: anExpl.createdAt },
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

  return {
    root, projectDir, project, units, construct, inst, dict, run, gsGold, gsSilver,
    anDsl, anExpl, humanAgreement, machineAgreement, L,
    expected: { sales, ops, diff },
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
  assert.ok(r.includes('read.csv("outputs/run_1.csv")'));
  assert.ok(r.includes('read.csv("gold/gs_gold.csv")'));
  assert.ok(r.includes('read.csv("units/corp_demo.csv")'));
  assert.ok(r.includes(F.expected.sales.est.toFixed(6)), "Concord's number missing from R comments");

  // every d$<col> the script references must be a CSV column or assigned in the script
  const headers = new Set(
    ["outputs/run_1.csv", "gold/gs_gold.csv", "units/corp_demo.csv"]
      .flatMap((p) => strFromU8(files[p]).split("\n")[0].split(","))
  );
  const assigned = new Set([...r.matchAll(/\w+\$(\w+)\s*<-/g)].map((m) => m[1]));
  for (const m of r.matchAll(/\w+\$(\w+)/g)) {
    const col = m[1];
    assert.ok(headers.has(col) || assigned.has(col), `reproduce.R references unknown column: ${col}`);
  }
  // the grouping column the formula uses exists in units csv
  assert.ok(headers.has("dept"));
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

  // self-contained: zero external URLs of any kind
  assert.ok(!/https?:\/\//.test(html), "external URL found in report HTML");

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
