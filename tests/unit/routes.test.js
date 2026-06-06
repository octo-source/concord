// Task I — API routes integration suite. Boots the real server on an
// ephemeral port over a temp projects dir, drives every domain through HTTP
// with MockModel as both Director and worker, and asserts the ledger story.
//
// Conventions (mirroring tests/integration/orchestration.test.js):
//   - hermetic bundles via CONCORD_PROJECTS_DIR; settings via CONCORD_CONFIG_DIR;
//   - ONE memoized MockAdapter shared with the modules under test; a single
//     master Director handler multiplexes on the response schema;
//   - tests run serially in declaration order and share state via S.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";

import { startServer } from "../../server/index.js";
import { getAdapter } from "../../server/providers/registry.js";
import { readNdjson, projectDir, updateProject } from "../../server/core/store.js";
import * as ledger from "../../server/core/ledger.js";
import { sha256 } from "../../server/core/ids.js";

// ---------------------------------------------------------------- harness

let tmpProjects;
let tmpConfig;
let srv;
let base;

before(async () => {
  tmpProjects = await mkdtemp(path.join(os.tmpdir(), "concord-routes-"));
  tmpConfig = await mkdtemp(path.join(os.tmpdir(), "concord-routes-cfg-"));
  process.env.CONCORD_PROJECTS_DIR = tmpProjects;
  process.env.CONCORD_CONFIG_DIR = tmpConfig;
  srv = await startServer({ port: 0 });
  base = `http://127.0.0.1:${srv.port}`;
  hermeticCatalogs();
});

after(async () => {
  await srv.close();
  delete process.env.CONCORD_PROJECTS_DIR;
  delete process.env.CONCORD_CONFIG_DIR;
  await rm(tmpProjects, { recursive: true, force: true }).catch(() => {});
  await rm(tmpConfig, { recursive: true, force: true }).catch(() => {});
});

// network-backed catalogs must not leave the machine during tests
function hermeticCatalogs() {
  for (const name of ["openrouter", "ollama"]) {
    const { adapter } = getAdapter({ privacyMode: "open" }, name);
    adapter.catalog = async () => [];
  }
}

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
  try { json = JSON.parse(text); } catch { /* non-JSON (zip/html) */ }
  return { status: res.status, json, text };
}

async function ok(method, p, body) {
  const r = await call(method, p, body);
  assert.equal(r.status, 200, `${method} ${p} → ${r.status}: ${r.text?.slice(0, 300)}`);
  assert.equal(r.json?.ok, true, `${method} ${p} envelope not ok`);
  return r.json.data;
}

async function fail(method, p, body, status, code) {
  const r = await call(method, p, body);
  assert.equal(r.status, status, `${method} ${p} expected ${status}, got ${r.status}: ${r.text?.slice(0, 300)}`);
  assert.equal(r.json?.ok, false);
  if (code) assert.equal(r.json.error.code, code, `expected error code ${code}, got ${r.json.error.code}`);
  return r.json.error;
}

async function upload(p, filename, content) {
  const form = new FormData();
  form.append("file", new Blob([content]), filename);
  const res = await fetch(base + p, { method: "POST", body: form });
  const json = JSON.parse(await res.text());
  assert.equal(res.status, 200, `upload ${p} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  assert.equal(json.ok, true);
  return json.data;
}

// Consume a complete SSE stream (the routes close them when done).
async function readSse(p, { method = "GET", body } = {}) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + p, init);
  if (!res.headers.get("content-type")?.includes("text/event-stream")) {
    const text = await res.text();
    return { status: res.status, events: [], raw: text };
  }
  const text = await res.text();
  const events = [];
  for (const block of text.split(/\n\n/)) {
    if (!block.trim()) continue;
    let event = "message";
    const data = [];
    for (const line of block.split(/\n/)) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      else if (line.startsWith("data: ")) data.push(line.slice(6));
    }
    if (data.length) events.push({ event, data: JSON.parse(data.join("\n")) });
  }
  return { status: res.status, events };
}

// ----------------------------------------------------------- mock director

const mock = () => getAdapter({ privacyMode: "open" }, "mock").adapter;
const ORACLE = (text) => (String(text).includes("salary") ? "yes" : "no");
const lastUser = (req) => [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
const shownUnitIds = (t) => [...new Set([...String(t).matchAll(/unit (u_[0-9a-f]{16})/g)].map((m) => m[1]))];

// shared scratch the master handler reads/writes
const H = { units: new Map(), briefIds: null, escalations: [] };

function masterHandler(req) {
  const user = lastUser(req);
  const props = req.schema?.properties ?? {};
  if (props.promptTemplate) {
    return { promptTemplate: "Compiled judge. {{definition}} {{criteria}} {{examples}} {{unit}}", note: "director compile/rewrite" };
  }
  if (props.reason) {
    H.escalations.push(user);
    return {
      rationale: "Sheer repetition of the word salary is not a concrete complaint.",
      label: "no",
      confidence: 0.9,
      reason: "Worker over-weighted repetition.",
    };
  }
  if (props.suggestions) return { suggestions: [] };
  if (props.paragraphs) {
    const ids = shownUnitIds(user);
    H.briefIds = ids;
    return {
      unitOfAnalysis: "One survey response per row.",
      paragraphs: [
        { md: "Respondents talk mostly about compensation.", refs: [ids[0], ids[1]] },
        { md: "A second cluster praises the team.", refs: [ids[2]] },
      ],
      themes: [{ name: "Pay", definition: "Complaints about compensation level.", quoteRefs: [ids[0]] }],
      redFlags: [],
      suggestedQuestions: ["Which departments complain about pay?"],
    };
  }
  if (props.themes) {
    const ids = shownUnitIds(user);
    return {
      themes: [{ name: "Pay", definition: "Compensation complaints.", quoteRefs: ids.slice(0, 2) }],
      note: "inductive sketch",
    };
  }
  if (props.constructs && props.instruments && props.analysis) {
    return {
      constructs: [{
        name: "Pay complaint (plan)",
        type: "binary",
        definition: "The unit complains about compensation.",
        criteria: { include: ["names pay as a problem"], exclude: ["benefits-only complaints"] },
        edgeCases: [],
        examples: [{ text: "the salary is too low", label: "yes", kind: "positive" }],
        categories: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
      }],
      instruments: [{ construct: "Pay complaint (plan)", workerClass: "small", provider: "mock", model: "mock-1", snapshot: "mock-1" }],
      analysis: {
        kind: "crosstab",
        spec: { rowKey: "label", colKey: "dept" },
        annotation: "Pay complaints by department answer the question.",
      },
    };
  }
  if (props.constructs) {
    return {
      constructs: [{
        name: "Imported construct",
        type: "binary",
        definition: "Recovered from a legacy codebook.",
        criteria: { include: ["matches the legacy rule"], exclude: [] },
        edgeCases: [],
        examples: [{ text: "sample text", label: "yes", kind: "positive" }],
        categories: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
      }],
    };
  }
  // silver labeling fallback: {rationale, label, confidence?}
  const ids = shownUnitIds(user);
  const u = H.units.get(ids.at(-1));
  return { rationale: "Applying the codebook as written.", label: ORACLE(u?.text ?? ""), confidence: 0.95 };
}

function armMock({ accuracy = 1.0 } = {}) {
  const m = mock();
  m.setAccuracy(accuracy);
  m.setOracle(ORACLE);
  m.setHandler("routes", masterHandler);
  return m;
}

// ----------------------------------------------------------------- corpora

function makeCsvA() {
  // 64 rows: planted pay theme on i%3===0, varied lengths, junk + dup + Spanish
  const lines = ["respondent_id,dept,tenure,response"];
  const baseText = (i) => (i % 3 === 0
    ? "the salary is too low for this work and it never improves"
    : "the office is comfortable and the team is genuinely kind");
  for (let i = 0; i < 64; i++) {
    let text;
    if (i === 60) text = "asdf";
    else if (i === 61) text = "n/a";
    else if (i === 62) text = baseText(1) + " Detail. Detail."; // dup of 63
    else if (i === 63) text = baseText(1) + " Detail. Detail.";
    else if (i === 50 || i === 51) text = "el equipo es muy bueno y la oficina es agradable para todos nosotros aqui";
    else text = baseText(i) + " Detail.".repeat(i % 4);
    lines.push(`r${i},${i % 2 ? "sales" : "ops"},${i % 5},${text}`);
  }
  return lines.join("\n") + "\n";
}

const LONG_ROW = 7;
function makeCsvB() {
  // 240 rows, all non-long padded to exactly 100 chars so ONLY the long unit
  // exceeds the p99 length escalation predicate
  const lines = ["respondent_id,dept,tenure,response"];
  for (let i = 0; i < 240; i++) {
    let text;
    if (i === LONG_ROW) {
      text = "the salary conversation keeps coming back and nobody addresses it properly here. ".repeat(10).trim();
    } else {
      text = (i % 3 === 0
        ? "the salary is too low for this work and morale drops"
        : "the office is comfortable and the team is genuinely kind").padEnd(100, ".");
    }
    lines.push(`r${i},${i % 2 ? "sales" : "ops"},${i % 10},${text}`);
  }
  return lines.join("\n") + "\n";
}

// ------------------------------------------------------------ shared state

const S = {
  slug: "demo-project",
  corpusA: null,
  corpusB: null,
  unitsA: [],
  unitsB: [],
  constructId: null, // "Pay complaint" — the calibrated pipeline construct
  construct2Id: null, // panel construct (no gold → exploratory analyses)
  inst1: null, // the judge that gets silver-tuned + frozen
  inst2: null, // pause/resume
  inst3: null, // abort/resume
  panelInst: null,
  dictInst: null,
  goldsetId: null,
  flipUnits: [], // units where coder B disagrees with coder A
  runId: null, // frozen-judge run on corpus B
  panelRunId: null,
  dictRunId: null,
  crosstabAnalysisId: null,
  crosstabAnalysis: null, // the full POST response, for the GET round-trip
};

const pdir = () => projectDir(S.slug);
const events = (opts) => ledger.query(pdir(), opts);
const getProject = () => ok("GET", `/api/projects/${S.slug}`);

const judgePayload = (template) => ({
  provider: "mock",
  model: "mock-1",
  snapshot: "mock-1",
  params: { temperature: 0, maxTokens: 64 },
  promptTemplate: template,
  schema: { type: "binary", options: ["yes", "no"] },
  rationaleFirst: true,
  workerClass: "frontier",
});

// =========================================================================
// health + projects
// =========================================================================

test("health reports version and provider reachability (mock always true)", async () => {
  const r = await call("GET", "/api/health");
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(typeof r.json.version, "string");
  assert.equal(r.json.providers.mock, true);
  for (const name of ["anthropic", "openai", "openrouter", "ollama"]) {
    assert.equal(typeof r.json.providers[name], "boolean", `${name} reachability is a boolean`);
  }
});

test("projects: create → ledger project.created; get; list; duplicates rejected; missing 404", async () => {
  const project = await ok("POST", "/api/projects", { name: "Demo Project", privacyMode: "no-training" });
  assert.equal(project.slug, S.slug);
  assert.equal(project.privacyMode, "no-training");
  assert.deepEqual(project.budget, { capUSD: null, spentUSD: 0 });

  const created = await events({ type: "project.created" });
  assert.equal(created.length, 1);
  assert.equal(created[0].actor, "human");

  const full = await getProject();
  assert.equal(full.id, project.id);

  const list = await ok("GET", "/api/projects");
  assert.ok(list.some((p) => p.slug === S.slug && p.counts));

  await fail("POST", "/api/projects", { name: "Demo Project" }, 400, "VALIDATION");
  await fail("GET", "/api/projects/no-such-project", undefined, 404, "NOT_FOUND");
});

test("settings: PUT configures the project Director slot (incl. systemSuffix)", async () => {
  await ok("PUT", "/api/settings", {
    project: {
      slug: S.slug,
      director: { provider: "mock", model: "mock-1", snapshot: "mock-1", systemSuffix: "[[handler:routes]]" },
    },
  });
  const p = await getProject();
  assert.equal(p.director.provider, "mock");
  assert.equal(p.director.systemSuffix, "[[handler:routes]]");
});

// =========================================================================
// import → confirm → units → instant read
// =========================================================================

test("import: upload CSV → mapping proposal + preview; confirm → corpus + junk queue + ledger order", async () => {
  const up = await upload(`/api/projects/${S.slug}/import`, "exit-survey.csv", makeCsvA());
  assert.match(up.importId, /^imp_/);
  assert.ok(up.mapping?.columns?.length >= 4);
  const responseCol = up.mapping.columns.find((c) => c.name === "response");
  assert.equal(responseCol.role, "text", "the response column auto-detects as text");
  assert.equal(up.preview.length, 20);

  const confirmed = await ok("POST", `/api/projects/${S.slug}/import/confirm`, {
    importId: up.importId,
    mapping: { textColumn: "response" },
    unitization: { scheme: "response" },
  });
  S.corpusA = confirmed.corpusId;
  assert.equal(confirmed.unitCount, 64);
  assert.ok(confirmed.junkQueue.counts.na >= 2, `na junk flagged (got ${JSON.stringify(confirmed.junkQueue.counts)})`);
  assert.ok(confirmed.junkQueue.counts.dup >= 1, "duplicate flagged");

  const imported = await events({ type: "corpus.imported" });
  const unitized = await events({ type: "corpus.unitized" });
  assert.equal(imported.length, 1);
  assert.equal(imported[0].actor, "human");
  assert.equal(imported[0].payload.rows, 64);
  assert.equal(unitized.length, 1);
  assert.equal(unitized[0].payload.unitCount, 64);
  assert.equal(unitized[0].payload.scheme, "response");

  const p = await getProject();
  const corpus = p.corpora.find((c) => c.id === S.corpusA);
  assert.equal(corpus.unitCount, 64);
  assert.equal(corpus.source.format, "csv");
  assert.equal(corpus.unitization.scheme, "response");

  // scope provenance recorded at confirm (the Kickstarter field failure: the
  // researcher must always be able to see WHICH column is in scope)
  assert.equal(corpus.textColumn, "response");
  assert.equal(corpus.scheme, "response");
  assert.deepEqual(corpus.junk, confirmed.junkQueue.counts);
  assert.equal(corpus.metaColumns, 3, "respondent_id, dept, tenure ride as metadata");
  assert.equal(corpus.sourceName, "exit-survey.csv");
});

test("corpora: units listing paginates and filters by meta + substring", async () => {
  const page = await ok("GET", `/api/projects/${S.slug}/corpora/${S.corpusA}/units?offset=0&limit=10`);
  assert.equal(page.units.length, 10);
  assert.equal(page.total, 64);

  const page2 = await ok("GET", `/api/projects/${S.slug}/corpora/${S.corpusA}/units?offset=60&limit=10`);
  assert.equal(page2.units.length, 4);

  const ops = await ok("GET", `/api/projects/${S.slug}/corpora/${S.corpusA}/units?meta.dept=ops&limit=500`);
  assert.ok(ops.total > 0 && ops.total < 64);
  assert.ok(ops.units.every((u) => u.meta.dept === "ops"));

  const q = await ok("GET", `/api/projects/${S.slug}/corpora/${S.corpusA}/units?q=salary&limit=500`);
  assert.ok(q.total >= 18 && q.total <= 22, `salary substring rows (got ${q.total})`);
  assert.ok(q.units.every((u) => u.text.includes("salary")));

  // remember corpus A units for the Director handler
  const all = await ok("GET", `/api/projects/${S.slug}/corpora/${S.corpusA}/units?limit=500`);
  S.unitsA = all.units;
  for (const u of all.units) H.units.set(u.id, u);
});

test("corpora: instant read computes locally and caches into the corpus meta", async () => {
  const r = await ok("GET", `/api/projects/${S.slug}/corpora/${S.corpusA}/instantread`);
  assert.equal(r.local, true);
  assert.ok(r.lengthHist.bins.length > 0);
  assert.ok(r.langMix.en > 0.8, `mostly English (got ${JSON.stringify(r.langMix)})`);
  assert.ok(r.langMix.es > 0, "Spanish rows detected");
  assert.ok(r.topTerms.some((t) => t.term === "salary"), `topTerms include salary: ${JSON.stringify(r.topTerms.slice(0, 8))}`);
  assert.equal(typeof r.sentimentSketch.meanValence, "number");
  assert.equal(r.sentimentSketch.lexicon, "VADER");
  const dept = r.metaMarginals.find((m) => m.column === "dept");
  assert.ok(dept && dept.values.length === 2);

  // the CTA price: the mock Director slot is configured → briefEstimate
  // {usd, etaMin} rides the response (ONE Director call over the stratified
  // sample, priced from the catalog — mock prices $0)
  assert.ok(r.briefEstimate && typeof r.briefEstimate === "object", "briefEstimate present with a Director configured");
  assert.equal(r.briefEstimate.usd, 0, "mock catalog pricing → $0");
  assert.equal(typeof r.briefEstimate.etaMin, "number");
  assert.ok(r.briefEstimate.etaMin > 0);

  // the scope block: WHAT was analyzed, straight from the corpus entry
  assert.equal(r.scope.textColumn, "response");
  assert.equal(r.scope.scheme, "response");
  assert.equal(r.scope.unitCount, 64);
  assert.equal(typeof r.scope.junk?.na, "number", "junk counts ride the scope block");
  assert.equal(r.scope.metaColumns, 3);
  assert.equal(r.scope.derivedFrom, null);

  const again = await ok("GET", `/api/projects/${S.slug}/corpora/${S.corpusA}/instantread`);
  assert.equal(again.computedAt, r.computedAt, "second call serves the cached result");
  assert.deepEqual(again.briefEstimate, r.briefEstimate, "the cached read still quotes the brief price");
  assert.deepEqual(again.scope, r.scope, "scope rides the cached read too");
  const cached = (await getProject()).corpora.find((c) => c.id === S.corpusA).instantread;
  assert.equal(cached.scope, undefined, "scope overlays per request — never baked into the cache");
  assert.equal(cached.briefEstimate, undefined, "briefEstimate stays per-request too");
});

// =========================================================================
// scope provenance: reunitize (the Kickstarter field failure) + legacy nulls
// =========================================================================

function makeKickstarterCsv() {
  // The field failure in miniature: a short title column wins unitization
  // while the real description (abouttxt) rides as metadata. Rows 10–11 have
  // no description at all (→ skipped on reunitize).
  const lines = ["name,state,abouttxt"];
  for (let i = 0; i < 12; i++) {
    const about = i < 10
      ? `We are building an open source hardware synthesizer with community documentation and full schematics release number ${i} for everyone.`
      : "";
    lines.push(`Project ${i},CA,${about}`);
  }
  return lines.join("\n") + "\n";
}

test("reunitize: versions the corpus onto a metadata text column — original untouched, old text preserved, skipped counted, ledgered", async () => {
  await ok("POST", "/api/projects", { name: "Kick Project" });
  const slug = "kick-project";
  const up = await upload(`/api/projects/${slug}/import`, "kickstarter.csv", makeKickstarterCsv());
  const confirmed = await ok("POST", `/api/projects/${slug}/import/confirm`, {
    importId: up.importId,
    mapping: { textColumn: "name" }, // the wrong choice the researcher made
    unitization: { scheme: "response" },
  });
  assert.equal(confirmed.unitCount, 12);

  let p = await ok("GET", `/api/projects/${slug}`);
  const orig = p.corpora.find((c) => c.id === confirmed.corpusId);
  assert.equal(orig.textColumn, "name");
  assert.equal(orig.scheme, "response");
  assert.deepEqual(orig.junk, { na: 0, short: 0, dup: 0, bot: 0 });
  assert.equal(orig.metaColumns, 2, "state + abouttxt");
  assert.equal(orig.sourceName, "kickstarter.csv");

  // fix the wrong text-column choice WITHOUT re-import
  const re = await ok("POST", `/api/projects/${slug}/corpora/${confirmed.corpusId}/reunitize`, { textColumn: "abouttxt" });
  assert.notEqual(re.corpusId, confirmed.corpusId, "re-unitization versions the corpus");
  assert.equal(re.textColumn, "abouttxt");
  assert.equal(re.unitCount, 10, "rows with an empty abouttxt are skipped");
  assert.equal(re.skipped, 2);
  assert.deepEqual(re.junk, { na: 0, short: 0, dup: 0, bot: 0 }, "junk counts ride the response");

  // new corpus: text swapped in, old text preserved under its original column name
  const newUnits = await ok("GET", `/api/projects/${slug}/corpora/${re.corpusId}/units?limit=500`);
  assert.equal(newUnits.total, 10);
  for (const u of newUnits.units) {
    assert.match(u.text, /open source hardware synthesizer/);
    assert.match(u.meta.name, /^Project \d+$/, "old unit text preserved under the old text column's name");
    assert.ok(!("abouttxt" in u.meta), "the promoted column left the metadata");
    assert.equal(u.meta.state, "CA", "other metadata carries over");
  }

  // original corpus untouched
  const oldUnits = await ok("GET", `/api/projects/${slug}/corpora/${confirmed.corpusId}/units?limit=500`);
  assert.equal(oldUnits.total, 12);
  assert.ok(oldUnits.units.every((u) => /^Project \d+$/.test(u.text)));

  // derived corpus entry: name + provenance + lineage
  p = await ok("GET", `/api/projects/${slug}`);
  assert.equal(p.corpora.length, 2);
  const derived = p.corpora.find((c) => c.id === re.corpusId);
  assert.equal(derived.name, "kickstarter.csv · text=abouttxt");
  assert.equal(derived.derivedFrom, confirmed.corpusId);
  assert.equal(derived.textColumn, "abouttxt");
  assert.equal(derived.scheme, "response");
  assert.deepEqual(derived.junk, { na: 0, short: 0, dup: 0, bot: 0 });
  assert.equal(derived.metaColumns, 2, "state + the preserved name column");
  assert.equal(derived.sourceName, "kickstarter.csv");
  assert.equal(derived.unitCount, 10);

  // ledger: corpus.unitized for the NEW corpus, actor human, contract payload
  const ev = await ledger.query(projectDir(slug), { type: "corpus.unitized" });
  assert.equal(ev.length, 2, "import-confirm + reunitize");
  assert.equal(ev.at(-1).actor, "human");
  assert.equal(ev.at(-1).refs.corpusId, re.corpusId);
  assert.deepEqual(ev.at(-1).payload, {
    textColumn: "abouttxt", derivedFrom: confirmed.corpusId, unitCount: 10, skipped: 2,
  });

  // 400 on a column that is not in the first unit's meta; 404 unknown corpus
  await fail("POST", `/api/projects/${slug}/corpora/${confirmed.corpusId}/reunitize`, { textColumn: "no_such_col" }, 400, "VALIDATION");
  await fail("POST", `/api/projects/${slug}/corpora/corp_missing/reunitize`, { textColumn: "abouttxt" }, 404, "NOT_FOUND");

  S.kick = { slug, origCorpus: confirmed.corpusId, derivedCorpus: re.corpusId };
});

test("corpora: instant read scope — derived corpus carries lineage; legacy entries render nulls, not throws", async () => {
  const { slug, origCorpus, derivedCorpus } = S.kick;
  const r = await ok("GET", `/api/projects/${slug}/corpora/${derivedCorpus}/instantread`);
  assert.deepEqual(r.scope, {
    textColumn: "abouttxt",
    scheme: "response",
    unitCount: 10,
    junk: { na: 0, short: 0, dup: 0, bot: 0 },
    metaColumns: 2,
    derivedFrom: origCorpus,
  });

  // a hand-built legacy corpus entry without ANY of the provenance fields
  const legacyId = "corp_legacy0000001";
  const dir = path.join(projectDir(slug), "corpora", legacyId);
  await mkdir(dir, { recursive: true });
  const legacyUnits = [
    { id: "u_00000000000000a1", text: "legacy unit one talking about nothing in particular today", meta: {}, pos: { row: 0 } },
    { id: "u_00000000000000a2", text: "legacy unit two carrying some other words entirely here", meta: {}, pos: { row: 1 } },
  ];
  await writeFile(path.join(dir, "units.ndjson"), legacyUnits.map((u) => JSON.stringify(u)).join("\n") + "\n", "utf8");
  await updateProject(slug, (p) => { p.corpora.push({ id: legacyId, name: "legacy corpus" }); });

  const lr = await ok("GET", `/api/projects/${slug}/corpora/${legacyId}/instantread`);
  assert.equal(lr.unitCount, 2, "the read itself still computes");
  assert.deepEqual(lr.scope, {
    textColumn: null, scheme: null, unitCount: null, junk: null, metaColumns: null, derivedFrom: null,
  });
});

// =========================================================================
// brief (SSE) + question bar
// =========================================================================

test("brief: SSE streams paragraphs in order then done; artifact + ledger via the module", async () => {
  armMock();
  const { status, events: evs } = await readSse(`/api/projects/${S.slug}/brief`, {
    method: "POST",
    body: { corpusId: S.corpusA },
  });
  assert.equal(status, 200);
  assert.deepEqual(evs.map((e) => e.event), ["para", "para", "done"]);
  assert.match(evs[0].data.md, /compensation/);
  assert.ok(Array.isArray(evs[0].data.refs) && evs[0].data.refs.length >= 1);
  assert.match(evs[2].data.briefId, /^brief_/);

  const p = await getProject();
  assert.equal(p.briefs.length, 1);
  assert.equal(p.briefs[0].id, evs[2].data.briefId);
  assert.equal((await events({ type: "brief.generated" }))[0].actor, "director");
});

test("brief: GET briefs/:bid returns the persisted artifact; missing → 404", async () => {
  const p = await getProject();
  const briefId = p.briefs[0].id;
  const brief = await ok("GET", `/api/projects/${S.slug}/briefs/${briefId}`);
  assert.equal(brief.id, briefId);
  assert.equal(brief.corpusId, S.corpusA);
  assert.equal(brief.authoredBy, "director");
  assert.equal(brief.paragraphs.length, 2);
  assert.match(brief.paragraphs[0].md, /compensation/);
  assert.ok(Array.isArray(brief.paragraphs[0].refs) && brief.paragraphs[0].refs.length >= 1, "refs ride the stored paragraphs");
  assert.ok(Array.isArray(brief.themes) && brief.themes.length >= 1);
  assert.equal(brief.textColumn, "response", "the artifact names the column its unit text came from");
  assert.equal(brief.metaColumns, 3);
  await fail("GET", `/api/projects/${S.slug}/briefs/brief_nope`, undefined, 404, "NOT_FOUND");
  await fail("GET", `/api/projects/no-such-project/briefs/${briefId}`, undefined, 404, "NOT_FOUND");
});

test("questionbar: compile plan → approve materializes constructs + instruments + pending runs", async () => {
  armMock();
  const { planId, plan } = await ok("POST", `/api/projects/${S.slug}/questionbar`, {
    question: "Which departments complain about pay?",
    corpusId: S.corpusA,
  });
  assert.match(planId, /^plan_/);
  assert.equal(plan.constructs.length, 1);
  assert.equal(plan.instruments.length, 1);
  assert.ok(plan.estimate.calls >= 64);

  const approved = await ok("POST", `/api/projects/${S.slug}/questionbar/${planId}/approve`);
  assert.equal(approved.constructIds.length, 1);
  assert.equal(approved.instrumentIds.length, 1);
  assert.equal(approved.runIds.length, 1, "approval preflights one pending run per instrument");

  const p = await getProject();
  assert.equal(p.plans[0].status, "approved");
  assert.ok(p.instruments.some((i) => i.id === approved.instrumentIds[0]));
  const run = p.runs.find((r) => r.id === approved.runIds[0]);
  assert.equal(run.status, "pending");
  assert.equal((await events({ type: "plan.compiled" })).length, 1);
  assert.equal((await events({ type: "plan.approved" })).length, 1);
  assert.equal((await events({ type: "run.preflight" })).length, 1);
});

// =========================================================================
// constructs
// =========================================================================

test("constructs: CRUD with ledger; delete guarded by dependent instruments", async () => {
  const c = await ok("POST", `/api/projects/${S.slug}/constructs`, {
    name: "Pay complaint",
    type: "binary",
    definition: "The unit complains about compensation level or fairness.",
    criteria: { include: ["names compensation as a problem"], exclude: ["benefits-only complaints"] },
    edgeCases: ["sarcastic praise of compensation counts"],
    examples: [
      { text: "What they pay us is insulting.", label: "yes", kind: "positive" },
      { text: "Great team, decent comp.", label: "no", kind: "negative" },
    ],
    categories: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
  });
  S.constructId = c.id;
  assert.equal(c.humanTouched, true);
  assert.ok((await events({ type: "construct.created", ref: c.id })).length === 1);

  const got = await ok("GET", `/api/projects/${S.slug}/constructs/${c.id}`);
  assert.equal(got.name, "Pay complaint");
  const list = await ok("GET", `/api/projects/${S.slug}/constructs`);
  assert.ok(list.some((x) => x.id === c.id), "GET list includes the construct");

  const updated = await ok("PUT", `/api/projects/${S.slug}/constructs/${c.id}`, {
    definition: "The unit complains about compensation level, raises, or pay fairness.",
  });
  assert.match(updated.definition, /raises/);
  assert.equal((await events({ type: "construct.edited", ref: c.id })).length, 1);

  // second construct for the panel (kept gold-free → exploratory analyses)
  const c2 = await ok("POST", `/api/projects/${S.slug}/constructs`, {
    name: "Team praise",
    type: "binary",
    definition: "The unit praises the team or colleagues.",
    criteria: { include: ["positive remarks about colleagues"], exclude: [] },
    categories: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
  });
  S.construct2Id = c2.id;

  // deletable when unreferenced
  const tmp = await ok("POST", `/api/projects/${S.slug}/constructs`, { name: "Throwaway", type: "binary" });
  await ok("DELETE", `/api/projects/${S.slug}/constructs/${tmp.id}`);
  await fail("GET", `/api/projects/${S.slug}/constructs/${tmp.id}`, undefined, 404, "NOT_FOUND");
});

test("constructs: docx codebook import returns Director proposals; inductive returns themes", async () => {
  armMock();
  const docx = await import("node:fs/promises").then((fs) =>
    fs.readFile(path.join(process.cwd(), "tests", "fixtures", "ingest-min.docx")));
  const form = new FormData();
  form.append("file", new Blob([docx]), "legacy-codebook.docx");
  const res = await fetch(`${base}/api/projects/${S.slug}/constructs/import`, { method: "POST", body: form });
  const body = JSON.parse(await res.text());
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 300));
  assert.equal(body.data.proposed, true);
  assert.equal(body.data.constructs[0].name, "Imported construct");
  assert.equal(body.data.constructs[0].authoredBy, "director");
  // proposals are NOT persisted
  const p = await getProject();
  assert.ok(!p.constructs.some((c) => c.name === "Imported construct"));

  const tax = await ok("POST", `/api/projects/${S.slug}/constructs/inductive`, { corpusId: S.corpusA, n: 20 });
  assert.equal(tax.mode, "inductive-hypothesis");
  assert.equal(tax.themes[0].name, "Pay");

  // explicit acceptance persists + ledgers construct.created
  const accepted = await ok("POST", `/api/projects/${S.slug}/constructs/accept`, {
    constructs: body.data.constructs,
  });
  assert.equal(accepted.constructIds.length, 1);
  await ok("DELETE", `/api/projects/${S.slug}/constructs/${accepted.constructIds[0]}`); // keep the graph tidy
});

test("constructs: draft — concepts formalize via the themes path; questions take the question path; nothing persists", async () => {
  const captured = [];
  mock().setHandler("routes", (req) => {
    captured.push(lastUser(req));
    return {
      constructs: [{
        name: "Pay fairness", type: "binary",
        definition: "The unit evaluates compensation fairness.",
        criteria: { include: ["names pay fairness"], exclude: [] },
        edgeCases: [],
        examples: [{ text: "the salary is too low for this work and it never improves", label: "yes", kind: "positive" }],
        categories: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
      }],
    };
  });

  const before = (await getProject()).constructs.length;

  // concepts: newline-separated names, optionally "name: hint" → themes path
  const r1 = await ok("POST", `/api/projects/${S.slug}/constructs/draft`, {
    input: "pay fairness\nburnout: exhaustion language",
    corpusId: S.corpusA,
  });
  assert.equal(r1.constructs.length, 1);
  assert.equal(r1.constructs[0].name, "Pay fairness");
  assert.equal(r1.constructs[0].authoredBy, "director");
  assert.equal(r1.constructs[0].humanTouched, false);
  assert.equal(r1.sampleN, 60, "seeded ~60-unit sample from the 64-unit corpus");
  assert.match(captured[0], /Draft one construct per theme below/);
  assert.match(captured[0], /- pay fairness/);
  assert.match(captured[0], /- burnout: exhaustion language/);

  // a research question (single line ending in "?") → question path
  const r2 = await ok("POST", `/api/projects/${S.slug}/constructs/draft`, {
    input: "Do creators promise open source?",
    corpusId: S.corpusA,
  });
  assert.equal(r2.constructs.length, 1);
  assert.equal(r2.sampleN, 60);
  assert.match(captured[1], /research question/);
  assert.match(captured[1], /"Do creators promise open source\?"/);
  assert.doesNotMatch(captured[1], /Draft one construct per theme below/);

  // a single line with no colon and >6 words is also a question; corpus defaults to the first
  const r3 = await ok("POST", `/api/projects/${S.slug}/constructs/draft`, {
    input: "how creators describe their funding goals over time",
  });
  assert.equal(r3.sampleN, 60);
  assert.match(captured[2], /research question/);

  // a single "name: hint" line stays a concept, not a question
  await ok("POST", `/api/projects/${S.slug}/constructs/draft`, {
    input: "burnout: exhaustion language",
    corpusId: S.corpusA,
  });
  assert.match(captured[3], /Draft one construct per theme below/);
  assert.match(captured[3], /- burnout: exhaustion language/);

  // proposals are NOT persisted — acceptance stays the separate human act
  const p = await getProject();
  assert.equal(p.constructs.length, before, "draft persisted nothing");
  assert.ok(!p.constructs.some((c) => c.name === "Pay fairness"));

  await fail("POST", `/api/projects/${S.slug}/constructs/draft`, {}, 400, "VALIDATION");

  armMock(); // restore the master handler for downstream tests
});

// =========================================================================
// instruments: CRUD, compile, preview, silver-tune, stability
// =========================================================================

test("instruments: create + re-version (level resets) + ephemeral preview", async () => {
  const inst = await ok("POST", `/api/projects/${S.slug}/instruments`, {
    constructId: S.constructId,
    kind: "judge",
    name: "Pay judge",
    payload: judgePayload("Initial template. {{definition}} {{criteria}} {{examples}} {{unit}}"),
  });
  S.inst1 = inst.id;
  assert.equal(inst.version, 1);
  assert.equal(inst.level, "exploratory");
  assert.equal((await events({ type: "instrument.created", ref: inst.id })).length, 1);
  const list = await ok("GET", `/api/projects/${S.slug}/instruments`);
  assert.ok(list.some((x) => x.id === inst.id), "GET list includes the instrument");
  const one = await ok("GET", `/api/projects/${S.slug}/instruments/${inst.id}`);
  assert.equal(one.versionHash, inst.versionHash);

  const v2 = await ok("PUT", `/api/projects/${S.slug}/instruments/${inst.id}`, {
    payload: judgePayload("Edited template. {{definition}} {{criteria}} {{examples}} {{unit}}"),
  });
  assert.equal(v2.version, 2);
  assert.notEqual(v2.versionHash, inst.versionHash);
  assert.equal(v2.level, "exploratory");
  assert.equal((await events({ type: "instrument.versioned", ref: inst.id })).length, 1);

  armMock();
  const ids = S.unitsA.slice(0, 3).map((u) => u.id);
  const preview = await ok("POST", `/api/projects/${S.slug}/instruments/${inst.id}/preview`, { unitIds: ids });
  const finals = preview.outputs.filter((o) => o.label !== undefined);
  assert.equal(finals.length, 3);
  for (const o of finals) assert.equal(o.label, ORACLE(H.units.get(o.unitId).text));
  const p = await getProject();
  assert.equal(p.runs.length, 1, "preview persisted NO run (only the plan's pending run exists)");
});

test("instruments: Director compile re-versions with the authored template", async () => {
  armMock();
  const v3 = await ok("POST", `/api/projects/${S.slug}/instruments/${S.inst1}/compile`, {});
  assert.equal(v3.version, 3);
  assert.match(v3.payload.promptTemplate, /^Compiled judge\./);
  for (const slot of ["{{definition}}", "{{criteria}}", "{{examples}}", "{{unit}}"]) {
    assert.ok(v3.payload.promptTemplate.includes(slot), `slot ${slot} survives`);
  }
  const versioned = await events({ type: "instrument.versioned", ref: S.inst1 });
  assert.equal(versioned.at(-1).payload.via, "director-compile");
});

test("instruments: silver-tune streams iterations then done; lands stabilized (real engine + stability injected)", async () => {
  armMock();
  const { status, events: evs } = await readSse(`/api/projects/${S.slug}/instruments/${S.inst1}/silver-tune`, {
    method: "POST",
    body: { n: 24, corpusId: S.corpusA },
  });
  assert.equal(status, 200);
  const iters = evs.filter((e) => e.event === "iteration");
  const done = evs.find((e) => e.event === "done");
  assert.ok(!evs.some((e) => e.event === "error"), `no error event: ${JSON.stringify(evs.find((e) => e.event === "error")?.data)}`);
  assert.ok(iters.length >= 1, "at least one iteration streamed");
  assert.deepEqual(iters.map((e) => e.data.iteration), iters.map((_, i) => i + 1), "iterations arrive in order");
  assert.equal(typeof iters[0].data.agreement, "number");
  assert.ok(done, "done event arrives");
  assert.equal(done.data.instrumentId, S.inst1);
  assert.equal(done.data.level, "stabilized");
  assert.equal(typeof done.data.cost.workerUSD, "number");

  const p = await getProject();
  const inst = p.instruments.find((i) => i.id === S.inst1);
  assert.equal(inst.level, "stabilized");
  assert.equal(inst.silver.iterations.length, iters.length);
  assert.equal(p.goldsets.length, 1, "the silver goldset registered");
  assert.equal(p.goldsets[0].tier, "silver");
  assert.equal(p.budget.spentUSD, 0, "mock spend rolls up as $0");
  assert.equal((await events({ type: "instrument.silver_tuned", ref: S.inst1 })).length, 1);
});

test("instruments: stability route returns alpha/pass; module owns the ledger event", async () => {
  armMock();
  const before = (await events({ type: "instrument.stability" })).length;
  const r = await ok("POST", `/api/projects/${S.slug}/instruments/${S.inst1}/stability`, {
    k: 2, n: 12, corpusId: S.corpusA,
  });
  assert.equal(r.alpha, 1, "accuracy-1.0 mock is perfectly stable");
  assert.equal(r.pass, true);
  const after = (await events({ type: "instrument.stability" })).length;
  assert.equal(after, before + 1, "exactly one instrument.stability event per check (module-owned)");
  const p = await getProject();
  assert.equal(p.instruments.find((i) => i.id === S.inst1).stability.alpha, 1);
});

// =========================================================================
// corpus B (the measurement corpus) + gold sets + blind coders
// =========================================================================

test("import: corpus B (240 rows) lands for the measurement pipeline", async () => {
  const up = await upload(`/api/projects/${S.slug}/import`, "exit-survey-full.csv", makeCsvB());
  const confirmed = await ok("POST", `/api/projects/${S.slug}/import/confirm`, {
    importId: up.importId,
    mapping: { textColumn: "response" },
    unitization: { scheme: "response" },
  });
  S.corpusB = confirmed.corpusId;
  assert.equal(confirmed.unitCount, 240);
  const all = await ok("GET", `/api/projects/${S.slug}/corpora/${S.corpusB}/units?limit=500`);
  S.unitsB = all.units;
  for (const u of all.units) H.units.set(u.id, u);
});

test("goldsets: create + SRS sample stores pi = n/N on every row; ledger goldset.sampled", async () => {
  const gs = await ok("POST", `/api/projects/${S.slug}/goldsets`, {
    constructId: S.constructId,
    tier: "gold",
    corpusId: S.corpusB,
  });
  S.goldsetId = gs.id;
  assert.equal(gs.status, "sampling");

  const sampled = await ok("POST", `/api/projects/${S.slug}/goldsets/${gs.id}/sample`, {
    design: "srs",
    n: 24,
  });
  assert.equal(sampled.n, 24);
  assert.ok(sampled.sample.every((s) => s.pi === 24 / 240), "pi = n/N stored on every sample row");

  const ev = await events({ type: "goldset.sampled", ref: gs.id });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].actor, "human");
  assert.equal(ev[0].payload.pi, 0.1);

  const full = await ok("GET", `/api/projects/${S.slug}/goldsets/${gs.id}`);
  assert.equal(full.status, "coding");
  assert.equal(full.sample.length, 24);
  const list = await ok("GET", `/api/projects/${S.slug}/goldsets`);
  assert.ok(list.some((g) => g.id === gs.id && g.n === 24), "GET list carries the goldset meta");
});

test("goldsets: stratified sampling allocates proportionally with per-stratum pi", async () => {
  const gs2 = await ok("POST", `/api/projects/${S.slug}/goldsets`, {
    constructId: S.constructId, tier: "gold", corpusId: S.corpusB,
  });
  const sampled = await ok("POST", `/api/projects/${S.slug}/goldsets/${gs2.id}/sample`, {
    design: "stratified", n: 20, strata: { by: "dept" },
  });
  assert.equal(sampled.n, 20);
  const pis = [...new Set(sampled.sample.map((s) => s.pi))];
  for (const pi of pis) assert.ok(pi > 0 && pi <= 1);
  // dept splits 120/120 → 10 from each stratum at pi 10/120
  assert.ok(pis.every((pi) => Math.abs(pi - 10 / 120) < 1e-12), `per-stratum pi (got ${pis})`);
  await ok("DELETE", `/api/projects/${S.slug}/goldsets/${gs2.id}`);
  await fail("GET", `/api/projects/${S.slug}/goldsets/${gs2.id}`, undefined, 404, "NOT_FOUND");
});

test("freeze BEFORE agreement → 400 (human agreement comes first)", async () => {
  const err = await fail("POST", `/api/projects/${S.slug}/instruments/${S.inst1}/freeze`,
    { goldsetId: S.goldsetId }, 400, "VALIDATION");
  assert.match(err.message, /human agreement/i);
});

test("coder sessions: two blind coders label through restricted same-process listeners", async () => {
  armMock();
  const sessA = await ok("POST", `/api/projects/${S.slug}/goldsets/${S.goldsetId}/coder-session`, { coderId: "coder-A" });
  const sessB = await ok("POST", `/api/projects/${S.slug}/goldsets/${S.goldsetId}/coder-session`, { coderId: "coder-B" });
  assert.ok(sessA.port > 0 && sessB.port > 0 && sessA.port !== sessB.port);
  assert.match(sessA.url, /^http:\/\/127\.0\.0\.1:\d+$/);

  const gsFull = await ok("GET", `/api/projects/${S.slug}/goldsets/${S.goldsetId}`);
  S.flipUnits = gsFull.sample.slice(0, 2).map((s) => s.unitId); // planted human disagreement

  const blindnessCheck = (raw, otherCoder) => {
    for (const marker of ['"juror"', '"rationale"', '"confidence"', '"aggregate"', '"escalat', '"adjudicated"', '"labels"', '"machine']) {
      assert.ok(!raw.includes(marker), `blind payload leaked ${marker}: ${raw.slice(0, 400)}`);
    }
    assert.ok(!raw.includes(otherCoder), `blind payload leaked the other coder (${otherCoder})`);
  };

  async function codeAll(sess, coderId, otherCoder, flip) {
    let labeled = 0;
    for (;;) {
      const res = await fetch(`${sess.url}/api/coder/next`);
      const raw = await res.text();
      assert.equal(res.status, 200);
      blindnessCheck(raw, otherCoder);
      const { data } = JSON.parse(raw);
      assert.equal(data.construct.name, "Pay complaint", "the codebook entry rides along");
      if (!data.unit) break;
      assert.equal(typeof data.unit.text, "string");
      const truth = ORACLE(data.unit.text);
      const label = flip && S.flipUnits.includes(data.unit.id) ? (truth === "yes" ? "no" : "yes") : truth;
      const post = await fetch(`${sess.url}/api/coder/label`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ unitId: data.unit.id, label, memo: labeled === 0 ? "first memo" : undefined }),
      });
      const postRaw = await post.text();
      assert.equal(post.status, 200, postRaw.slice(0, 300));
      blindnessCheck(postRaw, otherCoder);
      labeled++;
    }
    return labeled;
  }

  assert.equal(await codeAll(sessA, "coder-A", "coder-B", false), 24);
  assert.equal(await codeAll(sessB, "coder-B", "coder-A", true), 24);

  const progA = await fetch(`${sessA.url}/api/coder/progress`).then((r) => r.json());
  assert.deepEqual([progA.data.done, progA.data.total], [24, 24]);

  // main-server next route is equally blind
  const mainNext = await call("GET", `/api/projects/${S.slug}/goldsets/${S.goldsetId}/next?coder=coder-A`);
  assert.equal(mainNext.status, 200);
  blindnessCheck(mainNext.text, "coder-B");
  assert.equal(mainNext.json.data.unit, null, "coder-A is finished");

  // one goldset.label event per submission, actor human, refs carry coder + unit
  const labels = await events({ type: "goldset.label", ref: S.goldsetId });
  assert.equal(labels.length, 48);
  assert.ok(labels.every((e) => e.actor === "human"));
  assert.ok(labels.every((e) => e.refs.coderId && e.refs.unitId));

  // main-server label route: re-submitting an existing label overwrites
  // without inflating progress (and ledgers its own goldset.label event)
  const relabel = await ok("POST", `/api/projects/${S.slug}/goldsets/${S.goldsetId}/label`, {
    coder: "coder-A",
    unitId: S.flipUnits[0],
    label: ORACLE(H.units.get(S.flipUnits[0]).text),
  });
  assert.deepEqual([relabel.done, relabel.total], [24, 24]);
  assert.equal((await events({ type: "goldset.label", ref: S.goldsetId })).length, 49);

  // close coder-B's listener; its port must stop answering
  const closed = await ok("DELETE", `/api/projects/${S.slug}/goldsets/${S.goldsetId}/coder-session?coderId=coder-B`);
  assert.equal(closed.closed, 1);
  await assert.rejects(fetch(`${sessB.url}/api/coder/next`), "closed listener refuses connections");
  S.sessA = sessA;
});

test("goldsets: agreement computes the HUMAN report first (persisted + ledgered), then per-instrument machine reports", async () => {
  armMock();
  const r = await ok("GET", `/api/projects/${S.slug}/goldsets/${S.goldsetId}/agreement`);
  assert.equal(r.humanAgreement.n, 24);
  assert.ok(Math.abs(r.humanAgreement.percent - 22 / 24) < 1e-9, `planted 2 disagreements (got ${r.humanAgreement.percent})`);
  assert.equal(typeof r.humanAgreement.kappa, "number");
  assert.equal(typeof r.humanAgreement.alpha, "number");
  assert.ok(Array.isArray(r.humanAgreement.confusion), "2-coder confusion matrix included");

  // persisted on the artifact BEFORE machine comparison + ledgered
  const gs = await ok("GET", `/api/projects/${S.slug}/goldsets/${S.goldsetId}`);
  assert.ok(gs.humanAgreement);
  assert.equal(gs.status, "adjudicating");
  const ev = await events({ type: "goldset.agreement", ref: S.goldsetId });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].actor, "human");

  // machine side: the tuned judge vs adjudicated-or-consensus gold (22 units
  // have consensus; 2 disputed units are excluded until adjudication)
  const mine = r.perInstrument.find((x) => x.instrumentId === S.inst1);
  assert.ok(mine, `inst1 in perInstrument: ${JSON.stringify(r.perInstrument.map((x) => x.instrumentId))}`);
  assert.ok(!mine.error, JSON.stringify(mine.error ?? null));
  assert.equal(mine.agreement.n, 22);
  assert.equal(mine.agreement.percent, 1, "accuracy-1.0 worker matches consensus gold");
  assert.ok(Array.isArray(mine.agreement.perClass));
});

test("goldsets: adjudication resolves the disputes → status complete + goldset.completed", async () => {
  for (const unitId of S.flipUnits) {
    const truth = ORACLE(H.units.get(unitId).text);
    const r = await ok("POST", `/api/projects/${S.slug}/goldsets/${S.goldsetId}/adjudicate`, { unitId, label: truth });
    assert.ok(["adjudicating", "complete"].includes(r.status));
  }
  const gs = await ok("GET", `/api/projects/${S.slug}/goldsets/${S.goldsetId}`);
  assert.equal(gs.status, "complete");
  assert.equal(Object.keys(gs.adjudicated).length, 2);
  assert.equal((await events({ type: "goldset.adjudicated", ref: S.goldsetId })).length, 2);
  assert.equal((await events({ type: "goldset.completed", ref: S.goldsetId })).length, 1);
});

test("instruments: freeze mints the certificate (human-first ordering in the ledger) and seals the instrument", async () => {
  armMock();
  const cert = await ok("POST", `/api/projects/${S.slug}/instruments/${S.inst1}/freeze`, { goldsetId: S.goldsetId });
  assert.equal(cert.goldsetId, S.goldsetId);
  assert.equal(cert.modelPinned, true);
  assert.equal(cert.agreement.n, 24);
  assert.equal(cert.agreement.percent, 1);
  assert.ok(cert.humanAgreement, "the certificate carries the HUMAN agreement computed first");
  assert.ok(Math.abs(cert.humanAgreement.percent - 22 / 24) < 1e-9);

  const p = await getProject();
  const inst = p.instruments.find((i) => i.id === S.inst1);
  assert.equal(inst.frozen, true);
  assert.equal(inst.level, "calibrated");
  assert.equal(inst.certificate.versionHash, inst.versionHash);

  // ledger ordering: goldset.agreement strictly precedes instrument.frozen
  const all = await events();
  const iAgreement = all.findIndex((e) => e.type === "goldset.agreement");
  const iFrozen = all.findIndex((e) => e.type === "instrument.frozen");
  assert.ok(iAgreement !== -1 && iFrozen !== -1 && iAgreement < iFrozen,
    `humanAgreement-first ordering (agreement@${iAgreement}, frozen@${iFrozen})`);
  assert.equal(all[iFrozen].actor, "human");

  // frozen → editing forks with lineage
  await fail("POST", `/api/projects/${S.slug}/instruments/${S.inst1}/freeze`, { goldsetId: S.goldsetId }, 400, "VALIDATION");
  const fork = await ok("PUT", `/api/projects/${S.slug}/instruments/${S.inst1}`, {
    payload: judgePayload("Fork after freeze. {{definition}} {{criteria}} {{examples}} {{unit}}"),
  });
  assert.notEqual(fork.id, S.inst1);
  assert.equal(fork.parentVersion, inst.versionHash);
  assert.equal(fork.frozen, false);
  await ok("DELETE", `/api/projects/${S.slug}/instruments/${fork.id}`); // keep the instrument graph tidy
});

// =========================================================================
// runs
// =========================================================================

test("runs: preflight returns estimate + privacyOk + budget without creating a run", async () => {
  const before = (await getProject()).runs.length;
  const pf = await ok("POST", `/api/projects/${S.slug}/runs/preflight`, {
    instrumentId: S.inst1,
    corpusId: S.corpusB,
  });
  assert.equal(pf.units, 240);
  assert.equal(pf.calls, 240);
  assert.equal(typeof pf.estUSD, "number");
  assert.equal(typeof pf.etaMin, "number");
  assert.equal(pf.privacyOk, true);
  assert.equal(pf.budget.wouldExceed, false);
  assert.equal((await getProject()).runs.length, before, "preflight persisted nothing");
});

test("runs: start frozen-judge run → monitor SSE ticks then done; outputs exactly-once; escalation override recorded", async () => {
  armMock();
  H.escalations.length = 0;
  const started = await ok("POST", `/api/projects/${S.slug}/runs`, {
    instrumentId: S.inst1,
    corpusId: S.corpusB,
  });
  S.runId = started.runId;
  assert.equal(started.total, 240);

  const { events: evs } = await readSse(`/api/projects/${S.slug}/runs/${S.runId}/monitor`);
  const ticks = evs.filter((e) => e.event === "tick");
  const done = evs.find((e) => e.event === "done");
  assert.ok(ticks.length >= 1, "at least one tick");
  for (let i = 1; i < ticks.length; i++) {
    assert.ok(ticks[i].data.done >= ticks[i - 1].data.done, "tick progress is monotonic");
  }
  assert.ok(done, "done event arrives");
  assert.equal(done.data.status, "complete");
  assert.deepEqual(done.data.checkpoint, { done: 240, total: 240 });

  // outputs: exactly one final line per unit; the ≫p99 unit carries the
  // Director's escalation override with provenance
  const lines = await readNdjson(path.join(pdir(), "runs", S.runId, "outputs.ndjson"));
  assert.equal(lines.length, 240);
  const seen = new Set();
  for (const l of lines) {
    const k = `${l.unitId}|${l.juror}`;
    assert.ok(!seen.has(k), `duplicate output line ${k}`);
    seen.add(k);
  }
  const escalated = lines.filter((l) => l.escalated);
  assert.equal(escalated.length, 1, "exactly the one long unit escalated");
  assert.equal(escalated[0].label, "no", "Director replacement label landed");
  assert.equal(escalated[0].escalatedBy, "director");
  assert.equal(H.escalations.length, 1);

  const esc = await ok("GET", `/api/projects/${S.slug}/runs/${S.runId}/escalations`);
  assert.equal(esc.length, 1);
  assert.equal(esc[0].escalatedBy, "director");

  const p = await getProject();
  const run = p.runs.find((r) => r.id === S.runId);
  assert.equal(run.status, "complete");
  assert.equal(run.escalation.count, 1);
  assert.equal(p.budget.spentUSD, 0, "mock run rolls up $0");
  const runEvents = (await events({ ref: S.runId })).map((e) => `${e.type}:${e.actor}`);
  assert.deepEqual(runEvents, [
    "run.preflight:system",
    "run.started:system",
    "run.completed:system",
    "run.escalation_summary:system",
  ]);
});

test("runs: pause mid-run then resume to completion (exactly-once outputs)", async () => {
  armMock();
  const inst2 = await ok("POST", `/api/projects/${S.slug}/instruments`, {
    constructId: S.constructId,
    kind: "judge",
    name: "Pause judge",
    payload: judgePayload("Pause-run template. {{definition}} {{criteria}} {{examples}} {{unit}}"),
  });
  S.inst2 = inst2.id;
  const { runId } = await ok("POST", `/api/projects/${S.slug}/runs`, { instrumentId: S.inst2, corpusId: S.corpusB });
  const paused = await ok("POST", `/api/projects/${S.slug}/runs/${runId}/pause`);
  assert.equal(paused.status, "paused");
  let p = await getProject();
  const mid = p.runs.find((r) => r.id === runId);
  assert.equal(mid.status, "paused");
  const partial = await readNdjson(path.join(pdir(), "runs", runId, "outputs.ndjson"));
  assert.ok(partial.length < 240, `paused before completion (${partial.length}/240)`);

  const resumed = await ok("POST", `/api/projects/${S.slug}/runs/${runId}/resume`);
  assert.equal(resumed.resumed, true);
  const { events: evs } = await readSse(`/api/projects/${S.slug}/runs/${runId}/monitor`);
  assert.equal(evs.find((e) => e.event === "done")?.data.status, "complete");

  const lines = await readNdjson(path.join(pdir(), "runs", runId, "outputs.ndjson"));
  assert.equal(lines.length, 240, "resume fills exactly the missing units");
  const seen = new Set(lines.map((l) => `${l.unitId}|${l.juror}`));
  assert.equal(seen.size, 240, "no duplicate (unit, juror) lines across pause/resume");
});

test("runs: abort is ledgered (actor human) and resumable", async () => {
  armMock();
  const inst3 = await ok("POST", `/api/projects/${S.slug}/instruments`, {
    constructId: S.constructId,
    kind: "judge",
    name: "Abort judge",
    payload: judgePayload("Abort-run template. {{definition}} {{criteria}} {{examples}} {{unit}}"),
  });
  S.inst3 = inst3.id;
  const { runId } = await ok("POST", `/api/projects/${S.slug}/runs`, { instrumentId: S.inst3, corpusId: S.corpusB });
  const aborted = await ok("POST", `/api/projects/${S.slug}/runs/${runId}/abort`);
  assert.equal(aborted.status, "aborted");
  const ev = await events({ type: "run.aborted", ref: runId });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].actor, "human");
  assert.equal(ev[0].payload.by, "human");

  await ok("POST", `/api/projects/${S.slug}/runs/${runId}/resume`);
  const { events: evs } = await readSse(`/api/projects/${S.slug}/runs/${runId}/monitor`);
  assert.equal(evs.find((e) => e.event === "done")?.data.status, "complete");
});

test("runs: budget gate blocks start with 400 BUDGET_EXCEEDED", async (t) => {
  const m = armMock();
  const origCatalog = m.catalog;
  m.catalog = async () => [{
    id: "mock-1", name: "Mock", family: "mock", ctx: 128000,
    pricing: { inUSDper1M: 1000, outUSDper1M: 1000 }, snapshot: "mock-1",
  }];
  t.after(() => { m.catalog = origCatalog; });
  await ok("PUT", "/api/settings", { project: { slug: S.slug, budget: { capUSD: 0.000001 } } });
  t.after(async () => { await ok("PUT", "/api/settings", { project: { slug: S.slug, budget: { capUSD: null } } }); });

  const pf = await ok("POST", `/api/projects/${S.slug}/runs/preflight`, { instrumentId: S.inst1, corpusId: S.corpusB });
  assert.ok(pf.estUSD > 0, "nonzero pricing yields a nonzero estimate");
  assert.equal(pf.budget.wouldExceed, true);

  await fail("POST", `/api/projects/${S.slug}/runs`, { instrumentId: S.inst1, corpusId: S.corpusB }, 400, "BUDGET_EXCEEDED");
});

test("runs: strict project + anthropic instrument → preflight privacyOk false, start 403 PRIVACY_BLOCKED", async () => {
  await ok("POST", "/api/projects", { name: "Locked Project", privacyMode: "strict" });
  const up = await upload("/api/projects/locked-project/import", "mini.csv",
    "id,response\n" + Array.from({ length: 6 }, (_, i) => `${i},this is a sufficiently long response text about salary number ${i} for parsing`).join("\n") + "\n");
  const confirmed = await ok("POST", "/api/projects/locked-project/import/confirm", {
    importId: up.importId, mapping: { textColumn: "response" }, unitization: { scheme: "response" },
  });
  const c = await ok("POST", "/api/projects/locked-project/constructs", {
    name: "Pay", type: "binary", categories: [{ value: "yes", label: "Y" }, { value: "no", label: "N" }],
  });
  const inst = await ok("POST", "/api/projects/locked-project/instruments", {
    constructId: c.id,
    kind: "judge",
    name: "Cloud judge",
    payload: { ...judgePayload("T {{definition}} {{criteria}} {{examples}} {{unit}}"), provider: "anthropic", model: "claude-sonnet-4-5", snapshot: null },
  });
  const pf = await ok("POST", "/api/projects/locked-project/runs/preflight", { instrumentId: inst.id, corpusId: confirmed.corpusId });
  assert.equal(pf.privacyOk, false);
  assert.match(pf.privacyError, /strict/);
  await fail("POST", "/api/projects/locked-project/runs", { instrumentId: inst.id, corpusId: confirmed.corpusId }, 403, "PRIVACY_BLOCKED");

  // no Director slot on this project → the instant read has no honest brief
  // price to quote: briefEstimate is null, never a fabricated $0
  const ir = await ok("GET", `/api/projects/locked-project/corpora/${confirmed.corpusId}/instantread`);
  assert.equal(ir.briefEstimate, null, "no Director configured → briefEstimate null");
});

test("runs: panel run → disagreement view ranks by entropy with a juror×juror matrix", async () => {
  armMock({ accuracy: 0.7 }); // imperfect jurors → real disagreement
  const panel = await ok("POST", `/api/projects/${S.slug}/instruments`, {
    constructId: S.construct2Id,
    kind: "panel",
    name: "Praise panel",
    payload: {
      // distinct params.seed per juror: judgeUnit threads it as req.seed, so
      // MockModel (which seeds on model + user message) decorrelates the
      // jurors the way distinct real models would
      jurors: [0, 1, 2].map((i) => ({
        ...judgePayload(`Panel juror ${i}. {{definition}} {{criteria}} {{examples}} {{unit}}`),
        params: { temperature: 0, maxTokens: 64, seed: i },
      })),
      aggregation: "majority",
    },
  });
  S.panelInst = panel.id;
  const { runId } = await ok("POST", `/api/projects/${S.slug}/runs`, { instrumentId: panel.id, corpusId: S.corpusB });
  S.panelRunId = runId;
  const { events: evs } = await readSse(`/api/projects/${S.slug}/runs/${runId}/monitor`);
  assert.equal(evs.find((e) => e.event === "done")?.data.status, "complete");
  mock().setAccuracy(1.0);

  const d = await ok("GET", `/api/projects/${S.slug}/runs/${runId}/disagreement`);
  assert.ok(d.byEntropy.length > 0, "imperfect jurors disagree somewhere");
  for (let i = 1; i < d.byEntropy.length; i++) {
    assert.ok(d.byEntropy[i - 1].entropy >= d.byEntropy[i].entropy, "entropy-ranked descending");
  }
  assert.equal(Object.keys(d.byEntropy[0].labels).length, 3, "per-juror labels on each row");
  assert.equal(d.jurorMatrix.jurors.length, 3);
  assert.equal(d.jurorMatrix.matrix[0][0], 1);
  assert.ok(d.jurorMatrix.matrix[0][1] < 1, "off-diagonal agreement below 1");
});

test("goldsets: uncertainty sampling ranks by cached run outputs", async () => {
  const gs3 = await ok("POST", `/api/projects/${S.slug}/goldsets`, {
    constructId: S.constructId, tier: "gold", corpusId: S.corpusB,
  });
  const sampled = await ok("POST", `/api/projects/${S.slug}/goldsets/${gs3.id}/sample`, {
    design: "uncertainty", n: 10,
  });
  assert.equal(sampled.n, 10);
  assert.ok(sampled.sample.every((s) => s.pi === 10 / 240));
  await ok("PUT", `/api/projects/${S.slug}/goldsets/${gs3.id}`, { status: "coding" });
  await ok("DELETE", `/api/projects/${S.slug}/goldsets/${gs3.id}`);
});

// =========================================================================
// analyses — DSL auto-selection
// =========================================================================

test("analyses: no gold for the construct → level = instrument level, no corrected block", async () => {
  const a = await ok("POST", `/api/projects/${S.slug}/analyses`, {
    kind: "descriptive",
    spec: { of: "label", runId: S.panelRunId },
  });
  assert.equal(a.level, "exploratory", "panel instrument is exploratory and Team praise has no gold set");
  assert.equal(a.results.estimator, undefined, "no correction estimator without gold");
  assert.equal(a.results.cells, undefined);
  assert.ok(a.results.distribution);
  assert.equal((await events({ type: "analysis.created", ref: a.id })).length, 1);
  const list = await ok("GET", `/api/projects/${S.slug}/analyses`);
  assert.ok(list.some((x) => x.id === a.id && x.level === "exploratory"), "GET list carries analysis metas");
});

test("analyses: complete gold set with pi → crosstab auto-corrects (DSL) with naive companion + minExpected honesty", async () => {
  const a = await ok("POST", `/api/projects/${S.slug}/analyses`, {
    kind: "crosstab",
    spec: { rowKey: "label", colKey: "dept", runId: S.runId },
  });
  S.crosstabAnalysisId = a.id;
  S.crosstabAnalysis = a;
  assert.equal(a.level, "corrected", "gold present → DSL auto-selected");
  assert.equal(a.results.estimator, "dslProportion");
  assert.equal(a.spec.goldsetId, S.goldsetId);
  assert.equal(typeof a.results.table.minExpected, "number");
  assert.ok(Array.isArray(a.results.table.matrix));

  const cells = a.results.cells;
  assert.ok(Array.isArray(cells) && cells.length >= 1, `corrected cells: ${JSON.stringify(cells)}`);
  assert.equal(a.results.groupBy, "dept");
  for (const cell of cells) {
    assert.equal(typeof cell.est, "number");
    assert.equal(typeof cell.naive.est, "number", "naive companion included beside the corrected value");
    assert.ok(cell.ciLo <= cell.est && cell.est <= cell.ciHi);
    // planted base rate is 1/3 per dept (with the escalated unit flipping one)
    assert.ok(Math.abs(cell.est - 1 / 3) < 0.15, `corrected est near planted rate (got ${cell.est})`);
  }
  if (cells.length === 2 && a.results.diff) {
    assert.equal(typeof a.results.diff.est, "number");
    assert.equal(typeof a.results.diff.naive.est, "number");
  }
  // honesty: no significance stars anywhere in the results payload
  assert.ok(!JSON.stringify(a.results).includes("*"), "no star decoration");
  assert.ok(Object.keys(a.evidence.cells).length > 0, "evidence cells link units");
});

test("analyses: GET analyses/:id serves the persisted artifact; absent → 404; unknown project → 404", async () => {
  const got = await ok("GET", `/api/projects/${S.slug}/analyses/${S.crosstabAnalysisId}`);
  assert.deepEqual(got, S.crosstabAnalysis, "the artifact on disk deep-equals what POST returned");
  await fail("GET", `/api/projects/${S.slug}/analyses/an_never_created`, undefined, 404, "NOT_FOUND");
  await fail("GET", `/api/projects/no-such-project/analyses/${S.crosstabAnalysisId}`, undefined, 404, "NOT_FOUND");
});

test("analyses: model (logit) corrects coefficients with the naive fit beside", async () => {
  const a = await ok("POST", `/api/projects/${S.slug}/analyses`, {
    kind: "model",
    spec: { x: ["tenure"], family: "logit", runId: S.runId },
  });
  assert.equal(a.level, "corrected");
  assert.equal(a.results.estimator, "dslLogit");
  assert.equal(a.results.coef.length, 2);
  assert.equal(a.results.naive.length, 2);
  assert.equal(a.results.coef[1].name, "tenure");
  assert.equal(a.results.nGold, 24);
});

test("analyses: triangulation between the frozen judge and a dictionary instrument", async () => {
  const dict = await ok("POST", `/api/projects/${S.slug}/instruments`, {
    constructId: S.constructId,
    kind: "dictionary",
    name: "Pay dictionary",
    payload: {
      categories: [{ name: "pay", terms: [{ term: "salary" }, { term: "pay*" }] }],
      negation: { enabled: false, window: 3 },
      scoring: "count",
    },
  });
  S.dictInst = dict.id;
  const { runId } = await ok("POST", `/api/projects/${S.slug}/runs`, { instrumentId: dict.id, corpusId: S.corpusB });
  S.dictRunId = runId;
  const { events: evs } = await readSse(`/api/projects/${S.slug}/runs/${runId}/monitor`);
  assert.equal(evs.find((e) => e.event === "done")?.data.status, "complete");

  const a = await ok("POST", `/api/projects/${S.slug}/analyses`, {
    kind: "triangulation",
    spec: { instrumentIds: [S.inst1, S.dictInst], corpusId: S.corpusB },
  });
  assert.equal(a.results.n, 240);
  assert.ok(a.results.percentAgreement >= 0.99, `judge and dictionary agree on the planted theme (got ${a.results.percentAgreement})`);
  const longUnit = S.unitsB.find((u) => u.meta.respondent_id === `r${LONG_ROW}`);
  assert.ok(a.results.divergent.some((d) => d.unitId === longUnit.id),
    "the Director-escalated unit diverges (judge no vs dictionary yes)");
});

test("analyses: subgroup reliability audit — machine-vs-gold agreement + κ + error rate by group, flagged >0.1 below overall; corrected cells still ride", async () => {
  const a = await ok("POST", `/api/projects/${S.slug}/analyses`, {
    kind: "subgroup",
    spec: { by: "dept", runId: S.runId },
  });
  assert.equal(a.level, "corrected");
  const r = a.results;

  // overall reference: accuracy-1.0 worker vs ORACLE gold — only the
  // Director-escalated long unit can disagree, so agreement ≥ 23/24
  assert.equal(typeof r.overall?.goldN, "number");
  assert.equal(r.overall.goldN, 24, "every π-bearing gold unit is read");
  assert.ok(r.overall.percentAgreement >= 23 / 24 - 1e-6, `near-perfect overall agreement (got ${r.overall.percentAgreement})`);
  assert.ok(Math.abs(r.overall.errorRate - (1 - r.overall.percentAgreement)) < 2e-6);

  assert.equal(r.groups.length, 2);
  for (const g of r.groups) {
    assert.ok(g.n > 0 && g.dist, "n + label distribution stay on every group");
    assert.equal(typeof g.goldN, "number");
    assert.ok(g.goldN > 0, `SRS gold reaches both depts (${g.group}: ${g.goldN})`);
    assert.ok(g.percentAgreement >= 0.8, `dialed-in worker agrees within ${g.group} (got ${g.percentAgreement})`);
    assert.ok(Math.abs(g.errorRate - (1 - g.percentAgreement)) < 2e-6, "errorRate = 1 − agreement");
    assert.ok(typeof g.kappa === "number" || g.kappa === null, "κ number|null");
    if (g.kappa === null) assert.equal(typeof g.note, "string", "a null κ explains itself");
    // the flagged computation, exactly: >0.1 below the overall agreement
    assert.equal(g.flagged, r.overall.percentAgreement - g.percentAgreement > 0.1);
    assert.equal(g.flagged, false, "a uniformly accurate worker flags no dept");
    if (g.corrected) {
      assert.equal(typeof g.corrected.est, "number");
      assert.equal(typeof g.corrected.naive.est, "number");
    }
  }
  assert.equal(r.groups.reduce((n, g) => n + g.goldN, 0), r.overall.goldN, "gold partitions over the groups");
  assert.ok(r.groups.some((g) => g.corrected), "at least one group carries a corrected estimate");
  assert.equal(r.estimator, "dslProportion", "the canonical corrected block survives for reporting/replication");
});

test("analyses: subgroup audit without a complete gold set → 400 with the calibrate-first message", async () => {
  const err = await fail("POST", `/api/projects/${S.slug}/analyses`, {
    kind: "subgroup",
    spec: { by: "dept", runId: S.panelRunId },
  }, 400, "VALIDATION");
  assert.match(err.message, /calibrate first/i, "researcher-facing message names the fix");
  assert.match(err.message, /gold/i);
});

// =========================================================================
// analyses — the Explorer contract (descriptive over a specific run)
// =========================================================================

test("analyses: descriptive with spec.runId carries the Explorer contract — prevalence, top-2 χ²-ranked crosstabs, nudge; no co-occurrence for scalar labels", async () => {
  const a = await ok("POST", `/api/projects/${S.slug}/analyses`, {
    kind: "descriptive",
    spec: { runId: S.runId },
  });
  const r = a.results;

  // prevalence: {label, count, share} from the run's final outputs (the
  // Director-escalated long unit landed "no", so yes = 80 of 240)
  assert.ok(Array.isArray(r.prevalence), "prevalence present");
  assert.deepEqual(r.prevalence, [
    { label: "no", count: 160, share: 0.666667 },
    { label: "yes", count: 80, share: 0.333333 },
  ]);

  // crosstabs: top 2 categorical-ish metadata keys, ranked by χ², each {by, table}
  assert.ok(Array.isArray(r.crosstabs) && r.crosstabs.length === 2,
    `two metadata crosstabs (got ${JSON.stringify(r.crosstabs?.map((x) => x.by))})`);
  assert.deepEqual(r.crosstabs.map((x) => x.by).sort(), ["dept", "tenure"], "id-like meta (respondent_id) never crosstabs");
  for (const xt of r.crosstabs) {
    assert.ok(Array.isArray(xt.table.rows) && Array.isArray(xt.table.cols) && Array.isArray(xt.table.matrix));
    assert.equal(typeof xt.table.chi2, "number");
    assert.equal(typeof xt.table.minExpected, "number");
  }
  assert.ok((r.crosstabs[0].table.chi2 ?? -1) >= (r.crosstabs[1].table.chi2 ?? -1), "ranked by χ² descending");

  // a binary judge run has no co-occurrence surface
  assert.equal(r.cooccurrence, undefined);

  // the calibration nudge: first non-calibrated instrument's construct, fixed price
  assert.deepEqual(r.calibrationNudge, { constructName: "Pay complaint (plan)", estUnits: 150, estMinutes: 35 });
});

test("analyses: multilabel dictionary run → co-occurrence {labels, matrix} in the Explorer contract", async () => {
  const c = await ok("POST", `/api/projects/${S.slug}/constructs`, {
    name: "Topics",
    type: "multilabel",
    definition: "Which planted topics the unit touches.",
    categories: [{ value: "pay", label: "Pay" }, { value: "team", label: "Team" }],
  });
  const inst = await ok("POST", `/api/projects/${S.slug}/instruments`, {
    constructId: c.id,
    kind: "dictionary",
    name: "Topics dictionary",
    payload: {
      categories: [
        { name: "pay", terms: [{ term: "salary" }] },
        { name: "team", terms: [{ term: "team" }] },
      ],
      negation: { enabled: false, window: 3 },
      scoring: "count",
    },
  });
  const { runId } = await ok("POST", `/api/projects/${S.slug}/runs`, { instrumentId: inst.id, corpusId: S.corpusB });
  const { events: evs } = await readSse(`/api/projects/${S.slug}/runs/${runId}/monitor`);
  assert.equal(evs.find((e) => e.event === "done")?.data.status, "complete");

  const a = await ok("POST", `/api/projects/${S.slug}/analyses`, { kind: "descriptive", spec: { runId } });
  const co = a.results.cooccurrence;
  assert.ok(co, "multilabel labels → co-occurrence present");
  assert.deepEqual(co.labels, ["pay", "team"]);
  // 81 salary units (80 planted + the long row — dictionaries skip escalation),
  // 159 team units, never both in one unit
  assert.deepEqual(co.matrix, [[81, 0], [0, 159]]);
  const pay = a.results.prevalence.find((p) => p.label === "pay");
  assert.deepEqual(pay, { label: "pay", count: 81, share: 0.3375 }, "multilabel prevalence counts each label");
});

// =========================================================================
// instruments — dictionary preview hit spans
// =========================================================================

test("instruments: dictionary preview returns per-unit hit spans for highlighting; judge previews carry none", async () => {
  const unit = S.unitsB.find((u) => u.text.startsWith("the salary is too low"));
  const preview = await ok("POST", `/api/projects/${S.slug}/instruments/${S.dictInst}/preview`, { unitIds: [unit.id] });
  const out = preview.outputs.find((o) => o.unitId === unit.id && o.label !== undefined);
  assert.ok(Array.isArray(out.hits), `dictionary preview outputs carry hits (got ${JSON.stringify(out)})`);
  const salary = out.hits.find((h) => h.term === "salary");
  assert.ok(salary, "the salary term hit is reported");
  assert.equal(salary.category, "pay");
  assert.equal(unit.text.slice(salary.start, salary.end), "salary", "the span indexes the unit text exactly");

  armMock();
  const jp = await ok("POST", `/api/projects/${S.slug}/instruments/${S.inst1}/preview`, { unitIds: [unit.id] });
  for (const o of jp.outputs) assert.equal(o.hits, undefined, "judge previews have no dictionary spans");
});

// =========================================================================
// evidence dossier
// =========================================================================

test("evidence: the dossier behind a unit — text, dictionary hits, outputs with provenance, gold labels, source pos", async () => {
  const gs = await ok("GET", `/api/projects/${S.slug}/goldsets/${S.goldsetId}`);
  const goldUnitId = gs.sample[0].unitId;
  const d = await ok("GET", `/api/projects/${S.slug}/evidence/${goldUnitId}`);
  assert.equal(d.unit.id, goldUnitId);
  assert.equal(typeof d.unit.text, "string");
  assert.ok(d.sourcePos && typeof d.sourcePos.row === "number");
  const dictEntry = d.dictionaryHits.find((x) => x.instrumentId === S.dictInst);
  assert.ok(dictEntry, "dictionary instrument contributes a hits entry");
  if (ORACLE(d.unit.text) === "yes") assert.ok(dictEntry.hits.length > 0, "pay terms highlighted");
  const judgeRun = d.outputs.find((o) => o.runId === S.runId);
  assert.ok(judgeRun, "outputs grouped by run include the frozen-judge run");
  assert.equal(judgeRun.outputs[0].label, ORACLE(d.unit.text));
  assert.ok(typeof judgeRun.outputs[0].rationale === "string" && judgeRun.outputs[0].rationale.length > 0);
  const goldEntry = d.goldLabels.find((g) => g.goldsetId === S.goldsetId);
  assert.ok(goldEntry, "gold labels included");
  assert.equal(goldEntry.coders["coder-A"], ORACLE(d.unit.text));
  assert.ok("coder-B" in goldEntry.coders);

  // escalated unit: provenance marker rides on the dossier
  const longUnit = S.unitsB.find((u) => u.meta.respondent_id === `r${LONG_ROW}`);
  const dLong = await ok("GET", `/api/projects/${S.slug}/evidence/${longUnit.id}`);
  const esc = dLong.outputs.find((o) => o.runId === S.runId).outputs[0];
  assert.equal(esc.escalated, true);
  assert.equal(esc.escalatedBy, "director");
});

// =========================================================================
// exports
// =========================================================================

test("exports: methods markdown cites the ledger; export.methods is the module's event", async () => {
  const r = await ok("GET", `/api/projects/${S.slug}/exports/methods?analysisId=${S.crosstabAnalysisId}`);
  assert.equal(r.analysisId, S.crosstabAnalysisId);
  assert.match(r.markdown, /^# Methods/);
  assert.match(r.markdown, /design-based supervised learning/);
  assert.match(r.markdown, /\[ledger:[0-9a-f]{8}\]/);
  assert.ok(r.citations.length >= 3, `citations present (got ${r.citations.length})`);
  assert.ok(r.citations.every((c) => /^[0-9a-f]{64}$/.test(c.hash)));
  assert.equal((await events({ type: "export.methods" })).length, 1);
});

test("exports: replication zip unzips with a verified MANIFEST", async () => {
  const res = await fetch(`${base}/api/projects/${S.slug}/exports/replication?analyses=${S.crosstabAnalysisId}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/zip");
  const buf = new Uint8Array(await res.arrayBuffer());
  const files = unzipSync(buf);
  const manifest = JSON.parse(strFromU8(files["MANIFEST.json"]));
  assert.equal(manifest.format, "concord-replication/1");
  for (const [member, hash] of Object.entries(manifest.files)) {
    assert.ok(files[member], `member ${member} present`);
    assert.equal(sha256(strFromU8(files[member])), hash, `MANIFEST hash verifies for ${member}`);
  }
  assert.ok(files["reproduce.py"] && files["reproduce.R"] && files["codebook.md"]);
  assert.ok(Object.keys(files).some((f) => f.startsWith("gold/")), "gold CSV included");
  assert.ok(Object.keys(files).some((f) => f.startsWith("outputs/")), "outputs CSV included");
  assert.equal((await events({ type: "export.replication" })).length, 1);
});

test("exports: report renders standalone HTML", async () => {
  const res = await fetch(`${base}/api/projects/${S.slug}/exports/report?analyses=${S.crosstabAnalysisId}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const html = await res.text();
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /Demo Project/);
  assert.match(html, /Evidence ladder/);
  // the report canvas previews methods (side-effect-free): still ONE export.methods event
  assert.equal((await events({ type: "export.methods" })).length, 1, "report rendering minted no export-of-record");
});

// =========================================================================
// goldsets — the human queue (π-null rows)
// =========================================================================

test("goldsets: queue routes a unit to the human queue (pi null, idempotent) — never a DSL gold row, still in agreement", async () => {
  armMock();
  const gs0 = await ok("GET", `/api/projects/${S.slug}/goldsets/${S.goldsetId}`);
  const inSample = new Set(gs0.sample.map((s) => s.unitId));
  const unit = S.unitsB.find((u) => !inSample.has(u.id));

  const q = await ok("POST", `/api/projects/${S.slug}/goldsets/${S.goldsetId}/queue`, { unitId: unit.id });
  assert.equal(q.queued, true);
  assert.equal(q.n, 25);
  const again = await ok("POST", `/api/projects/${S.slug}/goldsets/${S.goldsetId}/queue`, { unitId: unit.id });
  assert.equal(again.already, true, "idempotent per unit");
  assert.equal(again.n, 25);
  await fail("POST", `/api/projects/${S.slug}/goldsets/${S.goldsetId}/queue`, { unitId: "u_not_a_real_unit" }, 404, "NOT_FOUND");

  const gs = await ok("GET", `/api/projects/${S.slug}/goldsets/${S.goldsetId}`);
  assert.equal(gs.sample.length, 25);
  assert.deepEqual(gs.sample.at(-1), { unitId: unit.id, pi: null, queued: true });

  // ledgered on the existing taxonomy with a distinct payload; once, not twice
  const ev = await events({ type: "goldset.sampled", ref: S.goldsetId });
  assert.equal(ev.length, 2, "original sample + one queue event (the idempotent repeat is silent)");
  assert.equal(ev.at(-1).payload.queuedUnit, unit.id);
  assert.equal(ev.at(-1).actor, "human");

  // adjudicate the queued unit: it now has a GOLD LABEL but pi stays null
  await ok("POST", `/api/projects/${S.slug}/goldsets/${S.goldsetId}/adjudicate`, { unitId: unit.id, label: ORACLE(unit.text) });

  // CRITICAL INVARIANT: the queued+adjudicated unit must never reach the
  // π-weighted estimators — the stats layer throws on y-without-pi, so this
  // request answering 200 proves the assembly FILTERS rather than throws
  const a = await ok("POST", `/api/projects/${S.slug}/analyses`, {
    kind: "model",
    spec: { x: ["tenure"], family: "logit", runId: S.runId },
  });
  assert.equal(a.level, "corrected");
  assert.equal(a.results.nGold, 24, "DSL gold rows exclude the π-null queued unit");

  // …while plain agreement (which needs no π) DOES read it
  const r = await ok("GET", `/api/projects/${S.slug}/goldsets/${S.goldsetId}/agreement`);
  assert.equal(r.goldLabeled, 25, "the queued+adjudicated unit counts as gold-labeled for agreement");
  const mine = r.perInstrument.find((x) => x.instrumentId === S.inst1);
  assert.ok(!mine.error, JSON.stringify(mine.error ?? null));
  assert.equal(mine.agreement.n, 25, "machine-vs-gold agreement includes the queued unit");
});

// =========================================================================
// catalog + settings + coder-listener restriction + final chain verify
// =========================================================================

test("catalog: aggregated model catalogs with a 1h cache", async () => {
  const r = await ok("GET", "/api/catalog/models");
  assert.equal(r.providers.mock[0].id, "mock-1");
  assert.ok(Array.isArray(r.providers.anthropic) && r.providers.anthropic.length > 0, "static anthropic catalog");
  assert.deepEqual(r.providers.ollama, [], "hermetic ollama catalog");
  const again = await ok("GET", "/api/catalog/models");
  assert.equal(again.cachedAt, r.cachedAt, "second call serves the cache");
});

test("settings: keys are masked on GET (sk-…last4) and never echoed in full", async () => {
  const secret = "sk-ant-api-key-1234abcd";
  await ok("PUT", "/api/settings", { keys: { anthropic: secret } });
  hermeticCatalogs(); // clearAdapterCache() rebuilt the adapters — re-patch network catalogs
  const r = await call("GET", "/api/settings");
  assert.equal(r.status, 200);
  assert.equal(r.json.data.keys.anthropic.configured, true);
  assert.equal(r.json.data.keys.anthropic.apiKey, "sk-…abcd");
  assert.ok(!r.text.includes(secret), "the raw key never leaves the server");
  // health now reports the key as configured
  const h = await call("GET", "/api/health");
  assert.equal(h.json.providers.mock, true);
});

test("settings: loosening privacy mode requires confirmDowngrade and is ledgered", async () => {
  await fail("PUT", "/api/settings", { project: { slug: "locked-project", privacyMode: "open" } }, 400, "VALIDATION");
  const r = await ok("PUT", "/api/settings", {
    project: { slug: "locked-project", privacyMode: "open" },
    confirmDowngrade: true,
  });
  assert.equal(r.project.privacyMode, "open");
  const ev = await ledger.query(projectDir("locked-project"), { type: "privacy.mode_changed" });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].actor, "human");
  assert.deepEqual([ev[0].payload.from, ev[0].payload.to], ["strict", "open"]);
  // tightening back needs no confirmation (not a downgrade)
  await ok("PUT", "/api/settings", { project: { slug: "locked-project", privacyMode: "strict" } });
});

test("projects: PUT /api/projects/:p shares the settings downgrade guard + ledger, and sets the budget cap", async () => {
  // locked-project is strict again — loosening without confirmation refuses
  await fail("PUT", "/api/projects/locked-project", { privacyMode: "open" }, 400, "VALIDATION");
  const updated = await ok("PUT", "/api/projects/locked-project", { privacyMode: "open", confirmDowngrade: true });
  assert.equal(updated.privacyMode, "open");
  const ev = await ledger.query(projectDir("locked-project"), { type: "privacy.mode_changed" });
  // the settings test above ledgered strict→open AND the tighten-back
  // open→strict; this route adds the third — one shared helper, one taxonomy
  assert.equal(ev.length, 3);
  assert.equal(ev.at(-1).actor, "human");
  assert.deepEqual([ev.at(-1).payload.from, ev.at(-1).payload.to], ["strict", "open"]);

  const capped = await ok("PUT", "/api/projects/locked-project", { budget: { capUSD: 12 } });
  assert.equal(capped.budget.capUSD, 12);
  await fail("PUT", "/api/projects/locked-project", { budget: { capUSD: -1 } }, 400, "VALIDATION");

  // tightening back is no downgrade; null clears the cap
  const back = await ok("PUT", "/api/projects/locked-project", { privacyMode: "strict", budget: { capUSD: null } });
  assert.equal(back.privacyMode, "strict");
  assert.equal(back.budget.capUSD, null);
  await fail("PUT", "/api/projects/no-such-project", { budget: { capUSD: 1 } }, 404, "NOT_FOUND");
});

test("coder listener: serves ONLY the coder surface (other API routes absent) and stays blind after machine runs exist", async () => {
  const r = await fetch(`${S.sessA.url}/api/projects`);
  assert.equal(r.status, 404, "project routes are not mounted on the coder listener");
  const r2 = await fetch(`${S.sessA.url}/api/projects/${S.slug}/runs/${S.runId}/escalations`);
  assert.equal(r2.status, 404, "run routes are not mounted on the coder listener");

  // post-run blindness: outputs.ndjson is full of machine labels now — the
  // coder payloads still carry none of it
  const next = await fetch(`${S.sessA.url}/api/coder/next`);
  const raw = await next.text();
  for (const marker of ['"juror"', '"rationale"', '"confidence"', '"escalat', '"aggregate"']) {
    assert.ok(!raw.includes(marker), `post-run blind payload leaked ${marker}`);
  }
  const prog = await fetch(`${S.sessA.url}/api/coder/progress`).then((x) => x.json());
  // 25, not 24: the human-queue test routed one more unit into the sample —
  // queued units join the blind coding queue like any sampled unit
  assert.deepEqual([prog.data.done, prog.data.total], [24, 25]);
  await ok("DELETE", `/api/projects/${S.slug}/goldsets/${S.goldsetId}/coder-session`);
});

test("the demo project's ledger chain verifies end-to-end", async () => {
  const v = await ledger.verify(pdir());
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.ok(v.length > 60, `a full pipeline's worth of events (got ${v.length})`);
});
