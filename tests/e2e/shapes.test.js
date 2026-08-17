// The screen-contract suite: every field path a screen module reads is
// asserted against the LIVE route's response, keyless (MockModel as Director
// and worker), over a 200-row slice of the committed demo corpus. When a
// screen reader and a route shape drift apart, THIS file is what fails.
//
// Organization: a compact end-to-end population (project → import →
// instantread → brief → constructs → instruments → run → explorer → goldset
// → agreement → freeze → analyses → evidence → exports → questionbar →
// settings), with each test named for the screen module whose reads it
// encodes. Silver-tune and stability are skipped for speed — their SSE
// shapes are covered by tests/unit/routes.test.js.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startServer } from "../../server/index.js";
import { getAdapter } from "../../server/providers/registry.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---------------------------------------------------------------- harness

let tmpProjects;
let tmpConfig;
let srv;
let base;

before(async () => {
  tmpProjects = await mkdtemp(path.join(os.tmpdir(), "concord-shapes-"));
  tmpConfig = await mkdtemp(path.join(os.tmpdir(), "concord-shapes-cfg-"));
  process.env.CONCORD_PROJECTS_DIR = tmpProjects;
  process.env.CONCORD_CONFIG_DIR = tmpConfig;
  srv = await startServer({ port: 0 });
  base = `http://127.0.0.1:${srv.port}`;
  // network-backed catalogs must not leave the machine during tests
  for (const name of ["openrouter", "ollama"]) {
    getAdapter({ privacyMode: "open" }, name).adapter.catalog = async () => [];
  }
  // a 200-row slice of the committed demo CSV + its planted truth
  const csv = await readFile(path.join(repoRoot, "demo", "techcorp-exit-survey.csv"), "utf8");
  S.csv = csv.split("\n").slice(0, 201).join("\n") + "\n";
  S.oracleDoc = JSON.parse(await readFile(path.join(repoRoot, "demo", "oracle.json"), "utf8"));
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

// Consume a complete SSE stream (the routes close them when done).
async function readSse(p, { method = "GET", body } = {}) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + p, init);
  if (!res.headers.get("content-type")?.includes("text/event-stream")) {
    return { status: res.status, events: [], raw: await res.text() };
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

// ------------------------------------------------------------ shared state

const S = {
  slug: "shapes-audit",
  csv: null,
  oracleDoc: null,
  corpusId: null,
  units: new Map(), // unitId → unit
  flagsById: new Map(), // unitId → planted theme flags
  flagsByText: new Map(), // unit text → flags (the worker oracle)
  briefId: null,
  payConstructId: null,
  dictInstId: null,
  judgeInstId: null,
  judgeRunId: null,
  dictRunId: null,
  goldsetId: null,
  goldIds: [],
  flips: [], // units where coder B disagrees with coder A
  crosstabId: null,
};

const payTruth = (text) => (S.flagsByText.get(text)?.pay ? "yes" : "no");
const getProject = () => ok("GET", `/api/projects/${S.slug}`);

// ----------------------------------------------------------- mock director

const mock = () => getAdapter({ privacyMode: "open" }, "mock").adapter;
const lastUser = (req) => [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
const shownUnitIds = (t) => [
  ...new Set([...String(t).matchAll(/unit (u_[0-9a-f]{16})/g)].map((m) => m[1])),
];

const BRIEF_THEMES = [
  {
    name: "Pay and compensation",
    flag: "pay",
    definition: "The response names pay, salary, or compensation as a problem.",
  },
  {
    name: "Management problems",
    flag: "management",
    definition: "The response criticizes managers, supervisors, or leadership.",
  },
  {
    name: "Workload and burnout",
    flag: "workload",
    definition: "The response describes unsustainable workload, hours, or burnout.",
  },
  {
    name: "Growth stagnation",
    flag: "growth",
    definition: "The response cites missing career growth or promotion paths.",
  },
];

function shapesHandler(req) {
  const user = lastUser(req);
  const props = req.schema?.properties ?? {};

  // Director compile → a fresh worker template
  if (props.promptTemplate) {
    return {
      promptTemplate:
        "Apply the codebook to the unit. {{definition}} {{criteria}} {{examples}} {{unit}}",
      note: "scripted compile (deterministic shapes Director)",
    };
  }

  // Escalation second opinion: ECHO the worker's label (no override)
  if (props.reason) {
    let label = "no";
    const m = user.match(/- label: (".*?"|\S+)/);
    if (m) {
      try {
        label = JSON.parse(m[1]);
      } catch {
        label = m[1];
      }
    }
    return {
      rationale: "Independent read reaches the same verdict.",
      label,
      confidence: 0.9,
      reason: "",
    };
  }

  // Corpus Brief
  if (props.paragraphs) {
    const ids = shownUnitIds(user);
    const withFlag = (flag) => ids.filter((id) => S.flagsById.get(id)?.[flag]).slice(0, 4);
    const themes = BRIEF_THEMES.map((t) => ({
      name: t.name,
      definition: t.definition,
      quoteRefs: withFlag(t.flag),
    })).filter((t) => t.quoteRefs.length >= 3);
    return {
      unitOfAnalysis: "One exit-survey response per row.",
      paragraphs: [
        { md: "Compensation dominates the corpus.", refs: withFlag("pay").slice(0, 2) },
        {
          md: "Management complaints form a second cluster.",
          refs: withFlag("management").slice(0, 2),
        },
        {
          md: "Workload and burnout language is common among short tenures.",
          refs: withFlag("workload").slice(0, 2),
        },
      ],
      themes,
      redFlags: [
        { kind: "duplicates", detail: "Several exact duplicate texts ride the slice.", refs: [] },
      ],
      suggestedQuestions: ["Which departments complain most about pay?"],
    };
  }

  // Question Bar plan
  if (props.constructs && props.instruments && props.analysis) {
    return {
      constructs: [
        {
          name: "Pay complaint (plan)",
          type: "binary",
          definition: "The response names pay, salary, or compensation as a problem.",
          criteria: {
            include: ["explicit complaint about pay level or fairness"],
            exclude: ["benefits-only complaints"],
          },
          edgeCases: [],
          examples: [
            { text: "the pay was simply too low for the work", label: "yes", kind: "positive" },
          ],
          categories: [
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
          ],
        },
      ],
      instruments: [
        {
          construct: "Pay complaint (plan)",
          workerClass: "small",
          provider: "mock",
          model: "mock-1",
          snapshot: "mock-1",
        },
      ],
      analysis: {
        kind: "crosstab",
        spec: { rowKey: "label", colKey: "dept" },
        annotation: "Cross pay complaints by department.",
      },
    };
  }

  // Inductive taxonomy
  if (props.themes) {
    const ids = shownUnitIds(user);
    return {
      themes: [
        {
          name: "Pay pressure",
          definition: "Compensation named as the decisive grievance.",
          quoteRefs: ids.slice(0, 2),
        },
        {
          name: "Manager churn",
          definition: "Manager turnover or absence as the decisive grievance.",
          quoteRefs: ids.slice(2, 4),
        },
      ],
      note: "inductive sketch over the shown sample",
    };
  }

  // Silver labeling fallback (unused here — silver-tune is skipped)
  const ids = shownUnitIds(user);
  const u = S.units.get(ids.at(-1));
  return {
    rationale: "Applying the codebook as written.",
    label: payTruth(u?.text ?? ""),
    confidence: 0.95,
  };
}

function armMock(accuracy = 0.9) {
  const m = mock();
  m.setAccuracy(accuracy);
  m.setOracle((unitText) => payTruth(unitText));
  m.setHandler("shapes", shapesHandler);
  return m;
}

// =========================================================================
// home.js — projects list + create
// =========================================================================

test("home.js: POST /api/projects returns the full project; GET /api/projects serves {counts} summaries (no corpusCount/unitCount/ladder)", async () => {
  const project = await ok("POST", "/api/projects", {
    name: "Shapes Audit",
    privacyMode: "no-training",
  });
  assert.equal(project.slug, S.slug);
  assert.equal(project.privacyMode, "no-training");
  assert.ok(project.budget && typeof project.budget === "object", "budget object on the project");

  await ok("PUT", "/api/settings", {
    project: {
      slug: S.slug,
      director: {
        provider: "mock",
        model: "mock-director",
        snapshot: "mock-1",
        systemSuffix: "[[handler:shapes]]",
      },
    },
  });

  const list = await ok("GET", "/api/projects");
  const mine = list.find((p) => p.slug === S.slug);
  assert.ok(mine, "the project lists");
  // the card reads: name, slug, privacyMode, createdAt, counts.{corpora,
  // constructs, instruments, goldsets, runs, analyses}
  assert.equal(typeof mine.name, "string");
  assert.equal(typeof mine.createdAt, "string");
  assert.equal(typeof mine.privacyMode, "string");
  assert.ok(mine.counts && typeof mine.counts === "object", "counts envelope present");
  for (const k of [
    "corpora",
    "constructs",
    "instruments",
    "goldsets",
    "runs",
    "analyses",
    "briefs",
  ]) {
    assert.equal(typeof mine.counts[k], "number", `counts.${k} is a number`);
  }
  // the fields the OLD card read must not be relied on — they don't exist
  assert.equal(mine.corpusCount, undefined, "no corpusCount on live summaries");
  assert.equal(mine.ladder, undefined, "no ladder rollup on live summaries");
});

// =========================================================================
// import.js — upload proposal + confirm
// =========================================================================

test("import.js: POST import → {importId, mapping.columns[{name, role, confidence, stats}], preview, issues}; confirm → {corpusId, unitCount, junkQueue.counts}", async () => {
  const up = await upload(`/api/projects/${S.slug}/import`, "shapes-slice.csv", S.csv);
  assert.match(up.importId, /^imp_/);
  // the screen reads proposal.mapping.columns — NOT proposal.columns
  assert.equal(up.columns, undefined, "columns live under mapping, not at the top level");
  assert.ok(
    Array.isArray(up.mapping?.columns) && up.mapping.columns.length >= 4,
    "mapping.columns array",
  );
  for (const col of up.mapping.columns) {
    assert.equal(typeof col.name, "string");
    assert.equal(typeof col.role, "string");
    assert.equal(typeof col.confidence, "number");
    assert.ok(col.stats && typeof col.stats === "object", `stats on column ${col.name}`);
  }
  assert.equal(up.mapping.columns.find((c) => c.name === "response")?.role, "text");
  assert.ok(Array.isArray(up.preview) && up.preview.length <= 20, "≤ 20 preview rows");
  assert.ok(Array.isArray(up.issues), "issues array (possibly empty)");

  const confirmed = await ok("POST", `/api/projects/${S.slug}/import/confirm`, {
    importId: up.importId,
    mapping: { textColumn: "response" },
    unitization: { scheme: "response" },
  });
  S.corpusId = confirmed.corpusId;
  assert.equal(confirmed.unitCount, 200, "all 200 slice rows unitize");
  // the toast sums junkQueue.counts — an object map, never a number
  assert.ok(confirmed.junkQueue && typeof confirmed.junkQueue === "object");
  assert.ok(
    confirmed.junkQueue.counts && typeof confirmed.junkQueue.counts === "object",
    "junkQueue.counts map",
  );
  for (const v of Object.values(confirmed.junkQueue.counts)) assert.equal(typeof v, "number");
  assert.ok(Array.isArray(confirmed.junkQueue.flagged), "junkQueue.flagged array");

  // wire the oracle maps for everything downstream
  const page = await ok("GET", `/api/projects/${S.slug}/corpora/${S.corpusId}/units?limit=500`);
  for (const u of page.units) {
    S.units.set(u.id, u);
    const flags = S.oracleDoc.rows[u.meta.respondent_id];
    assert.ok(flags, `oracle.json carries flags for ${u.meta.respondent_id}`);
    S.flagsById.set(u.id, flags);
    S.flagsByText.set(u.text, flags);
  }
  assert.equal(S.units.size, 200);
});

test("corpora units (instruments.js preview sample, units listings): {units, total, offset, limit} with unit {id, text, meta, pos}", async () => {
  const page = await ok(
    "GET",
    `/api/projects/${S.slug}/corpora/${S.corpusId}/units?offset=0&limit=5`,
  );
  assert.equal(page.units.length, 5);
  assert.equal(page.total, 200);
  assert.equal(typeof page.offset, "number");
  assert.equal(typeof page.limit, "number");
  for (const u of page.units) {
    assert.match(u.id, /^u_[0-9a-f]{16}$/);
    assert.equal(typeof u.text, "string");
    assert.ok(u.meta && typeof u.meta === "object");
    assert.ok(u.pos && typeof u.pos === "object");
  }
});

// =========================================================================
// instantread.js — THE regression that started this audit
// =========================================================================

test("instantread.js: lengthHist is {bins, unit} (NOT an array), langMix an object of shares, topTerms [{term, count}], sentimentSketch {lexicon,…}, metaMarginals [{column, values}]", async () => {
  const r = await ok("GET", `/api/projects/${S.slug}/corpora/${S.corpusId}/instantread`);
  assert.equal(r.local, true, "instant read computes entirely locally");
  assert.equal(typeof r.unitCount, "number");

  // the live-walkthrough crash: (read.lengthHist ?? []).map is not a function
  assert.equal(
    Array.isArray(r.lengthHist),
    false,
    "lengthHist is NOT an array — it is {bins, unit}",
  );
  assert.ok(Array.isArray(r.lengthHist.bins) && r.lengthHist.bins.length > 0, "lengthHist.bins");
  assert.equal(r.lengthHist.unit, "words");
  for (const b of r.lengthHist.bins) {
    assert.equal(typeof b.lo, "number");
    assert.equal(typeof b.hi, "number");
    assert.equal(typeof b.n, "number");
  }

  assert.equal(Array.isArray(r.langMix), false, "langMix is an object of shares, not an array");
  assert.equal(typeof r.langMix.en, "number");
  assert.ok(r.langMix.en > 0.8, `mostly English (${JSON.stringify(r.langMix)})`);

  assert.ok(
    Array.isArray(r.topTerms) && r.topTerms.length > 0 && r.topTerms.length <= 20,
    "≤ 20 topTerms",
  );
  for (const t of r.topTerms) {
    assert.equal(typeof t.term, "string");
    assert.equal(
      typeof t.count,
      "number",
      `topTerms carry {term, count} (got ${JSON.stringify(t)})`,
    );
    assert.ok(t.term.length >= 3, `term "${t.term}" has min length 3`);
  }

  const sk = r.sentimentSketch;
  assert.equal(sk.lexicon, "VADER");
  for (const k of ["positive", "negative", "neutral", "meanValence"]) {
    assert.equal(typeof sk[k], "number", `sentimentSketch.${k}`);
  }
  assert.equal(sk.rows, undefined, "no per-satisfaction rows on the live sketch");

  assert.ok(Array.isArray(r.metaMarginals) && r.metaMarginals.length > 0);
  const dept = r.metaMarginals.find((m) => m.column === "dept");
  assert.ok(dept, "dept marginal keyed by `column` (not `key`)");
  assert.ok(Array.isArray(dept.values));
  for (const v of dept.values) {
    assert.equal(typeof v.value, "string");
    assert.equal(typeof v.n, "number");
  }

  assert.equal(typeof r.computedAt, "string", "computedAt cache marker");

  // the CTA price (design §6.1: the level-up affordance always states its
  // price): briefEstimate is {usd, etaMin} | null — null only when no
  // Director slot is configured. This harness configured the mock Director
  // before importing, so the brief is priced (at mock's $0).
  assert.ok("briefEstimate" in r, "briefEstimate field present (null | {usd, etaMin})");
  assert.ok(
    r.briefEstimate !== undefined && r.briefEstimate !== null,
    "a configured Director slot prices the brief",
  );
  assert.equal(typeof r.briefEstimate.usd, "number");
  assert.equal(typeof r.briefEstimate.etaMin, "number");
  assert.equal(r.briefEstimate.usd, 0, "keyless mock prices the brief at $0");
  assert.ok(r.briefEstimate.etaMin > 0, "one long Director call still costs wall-clock time");
});

test("corpora.js route: distinctive-terms ranking surfaces planted theme vocabulary, never connective glue", async () => {
  const r = await ok("GET", `/api/projects/${S.slug}/corpora/${S.corpusId}/instantread`);
  const terms = new Set(r.topTerms.map((t) => t.term));
  // planted themes: pay (pay/salary), management (manager/management),
  // remote/RTO (office/commute/mandate). The workload theme's vocabulary is
  // spread across many tokens (pace, hours, burnout…) and does not
  // consolidate on one word in a 200-row slice — covered by the absence
  // checks instead.
  assert.ok(terms.has("pay"), `"pay" in top terms: ${[...terms].join(", ")}`);
  assert.ok(terms.has("salary"), `"salary" in top terms`);
  assert.ok(
    ["manager", "management", "managers"].some((w) => terms.has(w)),
    `management vocabulary in top terms: ${[...terms].join(", ")}`,
  );
  assert.ok(
    ["office", "commute", "mandate", "remote", "hybrid"].some((w) => terms.has(w)),
    `remote-policy vocabulary in top terms: ${[...terms].join(", ")}`,
  );
  // the connective glue the old frequency ranking surfaced
  for (const bad of [
    "meanwhile",
    "honestly",
    "plus",
    "same",
    "beyond",
    "top",
    "made",
    "never",
    "also",
    "really",
  ]) {
    assert.ok(!terms.has(bad), `connective "${bad}" is stopworded out`);
  }
});

// =========================================================================
// brief.js — SSE stream + stored artifact
// =========================================================================

test("brief.js: SSE para {md, refs} + done {briefId}; artifact carries sample.{n, design}, themes [{name, definition, quoteRefs}], redFlags [{kind, detail, refs}]", async () => {
  armMock(0.98);
  const { status, events } = await readSse(`/api/projects/${S.slug}/brief`, {
    method: "POST",
    body: { corpusId: S.corpusId },
  });
  assert.equal(status, 200);
  const paras = events.filter((e) => e.event === "para");
  const done = events.find((e) => e.event === "done");
  assert.ok(paras.length >= 3, `paragraphs streamed (${paras.length})`);
  for (const pe of paras) {
    assert.equal(typeof pe.data.md, "string");
    assert.ok(Array.isArray(pe.data.refs));
  }
  assert.ok(done, "done event arrives");
  assert.equal(typeof done.data.briefId, "string");
  S.briefId = done.data.briefId;

  const brief = await ok("GET", `/api/projects/${S.slug}/briefs/${S.briefId}`);
  assert.equal(typeof brief.createdAt, "string");
  assert.equal(typeof brief.humanTouched, "boolean");
  assert.equal(typeof brief.unitOfAnalysis, "string");
  // the screen reads sample.n / sample.design — NOT sampleN/sampleDesign
  assert.equal(brief.sampleN, undefined, "no flat sampleN — it nests under sample");
  assert.equal(typeof brief.sample?.n, "number");
  assert.equal(typeof brief.sample?.design, "string");
  assert.ok(Array.isArray(brief.paragraphs) && brief.paragraphs.length >= 3);
  for (const p of brief.paragraphs) {
    assert.equal(typeof p.md, "string");
    assert.ok(Array.isArray(p.refs));
  }
  assert.ok(
    Array.isArray(brief.themes) && brief.themes.length >= 3,
    `themes (got ${brief.themes.length})`,
  );
  for (const t of brief.themes) {
    assert.equal(typeof t.name, "string");
    assert.equal(typeof t.definition, "string");
    assert.ok(Array.isArray(t.quoteRefs), "themes anchor via quoteRefs");
    for (const ref of t.quoteRefs) assert.ok(S.units.has(ref), `quoteRef ${ref} resolves`);
  }
  for (const f of brief.redFlags ?? []) {
    assert.equal(typeof f.kind, "string");
    assert.equal(typeof f.detail, "string", "red flags carry `detail`, not `note`");
    assert.ok(Array.isArray(f.refs));
  }
  assert.ok(Array.isArray(brief.suggestedQuestions));
  assert.equal(typeof brief.issues?.invalidRefs, "number");
});

// =========================================================================
// constructs.js — CRUD + inductive taxonomy + import envelope
// =========================================================================

test("constructs.js: POST/GET constructs round-trip the full construct; inductive returns a TAXONOMY {mode, themes [{name, definition, quoteRefs}], sampleN, note} — not a construct array", async () => {
  armMock(0.98);
  const pay = await ok("POST", `/api/projects/${S.slug}/constructs`, {
    name: "Pay complaint",
    type: "binary",
    definition: "The response names pay, salary, or compensation as a problem.",
    criteria: {
      include: ["explicit complaint about pay level, raises, bonus, or fairness"],
      exclude: ["benefits-only complaints"],
    },
    edgeCases: ["sarcastic praise of pay counts as a complaint"],
    examples: [
      { text: "the pay was simply too low for the work", label: "yes", kind: "positive" },
      { text: "the team itself was genuinely kind", label: "no", kind: "negative" },
    ],
    categories: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
  });
  S.payConstructId = pay.id;
  assert.equal(typeof pay.id, "string");
  assert.equal(pay.authoredBy, "human");
  assert.equal(typeof pay.humanTouched, "boolean");
  assert.ok(Array.isArray(pay.criteria.include) && Array.isArray(pay.criteria.exclude));
  assert.ok(Array.isArray(pay.edgeCases));
  assert.ok(Array.isArray(pay.examples) && pay.examples.every((ex) => ex.text && ex.kind));
  assert.ok(
    Array.isArray(pay.categories) &&
      pay.categories.every((c) => "value" in c && typeof c.label === "string"),
  );

  const list = await ok("GET", `/api/projects/${S.slug}/constructs`);
  assert.ok(Array.isArray(list) && list.some((k) => k.id === pay.id));

  // origin provenance: the inductive accept path sends origin: "inductive"
  // (+ draftedFrom), the Director draft accept path sends origin: "draft" —
  // both round-trip; absent stays absent; anything else rejects
  const adopted = await ok("POST", `/api/projects/${S.slug}/constructs`, {
    name: "Adopted theme",
    type: "binary",
    categories: [
      { value: "present", label: "Present" },
      { value: "absent", label: "Absent" },
    ],
    authoredBy: "director",
    humanTouched: false,
    origin: "inductive",
    draftedFrom: S.corpusId,
  });
  assert.equal(adopted.origin, "inductive", "origin round-trips on the created construct");
  assert.equal(adopted.draftedFrom, S.corpusId, "draftedFrom rides beside origin");
  const adoptedGot = await ok("GET", `/api/projects/${S.slug}/constructs/${adopted.id}`);
  assert.equal(adoptedGot.origin, "inductive", "origin persists through GET");
  assert.equal(pay.origin, undefined, "constructs created without an origin carry none");
  const badOrigin = await call("POST", `/api/projects/${S.slug}/constructs`, {
    name: "Bad origin",
    type: "binary",
    origin: "telepathy",
  });
  assert.equal(badOrigin.status, 400, "unknown origin values reject");
  assert.equal(badOrigin.json?.error?.code, "VALIDATION");
  await ok("DELETE", `/api/projects/${S.slug}/constructs/${adopted.id}`);

  // the inductive flow: the screen maps taxonomy THEMES to draft constructs
  const taxonomy = await ok("POST", `/api/projects/${S.slug}/constructs/inductive`, {
    corpusId: S.corpusId,
    n: 24,
  });
  assert.equal(
    Array.isArray(taxonomy),
    false,
    "inductive returns one artifact, not an array of proposals",
  );
  assert.equal(taxonomy.mode, "inductive-hypothesis");
  assert.equal(typeof taxonomy.sampleN, "number");
  assert.equal(typeof taxonomy.note, "string");
  assert.ok(Array.isArray(taxonomy.themes) && taxonomy.themes.length > 0);
  for (const t of taxonomy.themes) {
    assert.equal(typeof t.name, "string");
    assert.equal(typeof t.definition, "string");
    assert.ok(Array.isArray(t.quoteRefs));
    assert.equal(t.type, undefined, "themes are NOT constructs — no type to render");
  }
  assert.equal(typeof taxonomy.issues?.invalidRefs, "number");
  // (POST constructs/import returns {constructs, proposed: true} — same
  // .constructs unwrap the screen does; exercising it needs a real DOCX, so
  // the envelope is pinned by the route source and the screen reader.)
});

// =========================================================================
// instruments.js — create/compile/list/preview + the catalog envelope
// =========================================================================

test("instruments.js: catalog is {providers: {name: [{id, name, family, pricing, snapshot}]}, cachedAt} — not a bare provider map", async () => {
  const cat = await ok("GET", "/api/catalog/models");
  assert.ok(cat.providers && typeof cat.providers === "object", "models nest under .providers");
  assert.equal(typeof cat.cachedAt, "string");
  assert.equal(cat.anthropic, undefined, "no top-level provider arrays");
  assert.ok(
    Array.isArray(cat.providers.mock) && cat.providers.mock.length > 0,
    "mock catalog present",
  );
  const m = cat.providers.mock[0];
  assert.equal(typeof m.id, "string");
  assert.equal(typeof m.name, "string");
  assert.equal(typeof m.family, "string");
  assert.equal(typeof m.pricing?.inUSDper1M, "number");
  assert.equal(typeof m.pricing?.outUSDper1M, "number");
  assert.ok("snapshot" in m);
});

test("instruments.js: create dictionary + judge; compile re-versions; list serves full instruments; preview → {outputs, cost, quarantine, missing} with dictionary hits + scores", async () => {
  armMock(0.9);
  const dict = await ok("POST", `/api/projects/${S.slug}/instruments`, {
    constructId: S.payConstructId,
    kind: "dictionary",
    name: "pay dictionary",
    payload: {
      categories: [
        {
          name: "pay",
          terms: [
            { term: "pay" },
            { term: "salary" },
            { term: "underpa*" },
            { term: "compensation" },
            { term: "raise" },
          ],
        },
      ],
      negation: { enabled: true, window: 3 },
      scoring: "percentOfWords",
    },
  });
  S.dictInstId = dict.id;
  assert.equal(dict.level, "exploratory");
  assert.equal(typeof dict.versionHash, "string");
  assert.equal(dict.frozen, false);

  const judge = await ok("POST", `/api/projects/${S.slug}/instruments`, {
    constructId: S.payConstructId,
    kind: "judge",
    name: "pay judge",
    payload: {
      provider: "mock",
      model: "mock-1",
      snapshot: "mock-1",
      params: { temperature: 0, maxTokens: 256 },
      promptTemplate: "Judge template. {{definition}} {{criteria}} {{examples}} {{unit}}",
      schema: { type: "binary" },
      rationaleFirst: true,
      workerClass: "small",
    },
  });
  S.judgeInstId = judge.id;

  const compiled = await ok(
    "POST",
    `/api/projects/${S.slug}/instruments/${S.judgeInstId}/compile`,
    {},
  );
  assert.equal(compiled.version, 2, "compile re-versions");
  assert.equal(typeof compiled.versionHash, "string");
  for (const slot of ["{{definition}}", "{{criteria}}", "{{examples}}", "{{unit}}"]) {
    assert.ok(compiled.payload.promptTemplate.includes(slot), `compiled template keeps ${slot}`);
  }

  // list: full instrument records (the editor reads payload/level/version…)
  const list = await ok("GET", `/api/projects/${S.slug}/instruments`);
  for (const inst of list) {
    assert.equal(typeof inst.id, "string");
    assert.equal(typeof inst.kind, "string");
    assert.equal(typeof inst.name, "string");
    assert.equal(typeof inst.level, "string");
    assert.equal(typeof inst.version, "number");
    assert.equal(typeof inst.versionHash, "string");
    assert.equal(typeof inst.frozen, "boolean");
    assert.ok(inst.payload && typeof inst.payload === "object");
  }

  // preview: the live envelope (the screen reads res.outputs, never a bare array)
  const ids = [...S.units.keys()].slice(0, 5);
  const prev = await ok("POST", `/api/projects/${S.slug}/instruments/${S.dictInstId}/preview`, {
    unitIds: ids,
  });
  assert.equal(Array.isArray(prev), false, "preview is an envelope, not a bare array");
  assert.ok(Array.isArray(prev.outputs));
  assert.ok(prev.cost && typeof prev.cost === "object");
  assert.ok(Array.isArray(prev.quarantine));
  assert.ok(Array.isArray(prev.missing));
  const withLabel = prev.outputs.filter((o) => o.label !== undefined);
  assert.ok(withLabel.length > 0, "dictionary preview produced labels");
  for (const o of withLabel) {
    assert.equal(typeof o.unitId, "string");
    assert.ok(Array.isArray(o.hits), "dictionary outputs carry hit spans");
    for (const h of o.hits) {
      assert.equal(typeof h.category, "string");
      assert.equal(typeof h.term, "string");
      assert.equal(typeof h.start, "number");
      assert.equal(typeof h.end, "number");
    }
    assert.ok(
      o.scores && typeof o.scores === "object",
      "dictionary outputs carry per-category scores",
    );
  }
});

// =========================================================================
// runs.js — preflight, start, monitor, the run record, escalations
// =========================================================================

test("runs.js: preflight → {units, calls, inputTokens, outputTokens, estUSD, etaMin, privacyOk, budget {capUSD, spentUSD, wouldExceed}} — flat tokens, no remainingUSD", async () => {
  const pf = await ok("POST", `/api/projects/${S.slug}/runs/preflight`, {
    instrumentId: S.judgeInstId,
    corpusId: S.corpusId,
  });
  assert.equal(pf.units, 200);
  assert.equal(typeof pf.calls, "number");
  assert.equal(typeof pf.inputTokens, "number", "tokens are FLAT inputTokens/outputTokens");
  assert.equal(typeof pf.outputTokens, "number");
  assert.equal(pf.tokens, undefined, "no nested tokens object");
  assert.equal(typeof pf.estUSD, "number");
  assert.equal(pf.estUSD, 0, "mock pricing estimates $0");
  assert.equal(typeof pf.etaMin, "number");
  assert.equal(pf.privacyOk, true);
  assert.ok(pf.budget && typeof pf.budget === "object", "budget envelope always present");
  assert.ok("capUSD" in pf.budget, "budget.capUSD (may be null)");
  assert.equal(typeof pf.budget.spentUSD, "number");
  assert.equal(typeof pf.budget.wouldExceed, "boolean");
  assert.equal(pf.budget.remainingUSD, undefined, "no remainingUSD — the screen computes it");
});

test("runs.js: start → {runId, estUSD, total}; monitor ticks {done, total, costUSD, labelDist, warnings, escalations} + done {runId, status, checkpoint, cost}; the run RECORD carries checkpoint/cost (no flat done/total/costUSD)", async () => {
  armMock(0.9);
  const started = await ok("POST", `/api/projects/${S.slug}/runs`, {
    instrumentId: S.judgeInstId,
    corpusId: S.corpusId,
  });
  S.judgeRunId = started.runId;
  assert.equal(typeof started.runId, "string");
  assert.equal(typeof started.estUSD, "number");
  assert.equal(started.total, 200);

  const { events } = await readSse(`/api/projects/${S.slug}/runs/${S.judgeRunId}/monitor`);
  const ticks = events.filter((e) => e.event === "tick");
  const done = events.find((e) => e.event === "done");
  assert.ok(ticks.length >= 1, "at least one tick");
  for (const t of ticks) {
    assert.equal(typeof t.data.done, "number");
    assert.equal(typeof t.data.total, "number");
    assert.equal(typeof t.data.costUSD, "number");
    assert.ok(t.data.labelDist && typeof t.data.labelDist === "object", "labelDist object");
    assert.ok(Array.isArray(t.data.warnings), "warnings array");
    for (const w of t.data.warnings) {
      assert.equal(typeof w, "object", "warnings are {kind, message} objects, not strings");
      assert.equal(typeof w.message, "string");
    }
    assert.equal(typeof t.data.escalations, "number");
  }
  assert.ok(done, "done event arrives");
  assert.equal(done.data.runId, S.judgeRunId);
  assert.equal(done.data.status, "complete");
  assert.ok(done.data.checkpoint && done.data.checkpoint.done === 200);
  assert.ok(done.data.cost && typeof done.data.cost.actualUSD === "number");

  // the run record in project.runs — what the list + detail screens read
  const p = await getProject();
  const run = p.runs.find((r) => r.id === S.judgeRunId);
  assert.ok(run, "run record persisted");
  assert.equal(run.status, "complete");
  assert.equal(run.done, undefined, "no flat done — progress nests under checkpoint");
  assert.equal(run.costUSD, undefined, "no flat costUSD — cost nests under cost.actualUSD");
  assert.equal(run.checkpoint.done, 200);
  assert.equal(run.checkpoint.total, 200);
  assert.equal(typeof run.cost.estUSD, "number");
  assert.equal(run.cost.actualUSD, 0, "keyless run costs $0");
  assert.equal(typeof run.escalation?.count, "number");
  assert.equal(typeof run.provider, "string");
  assert.equal(typeof run.model, "string");
  assert.equal(typeof run.pinned, "boolean");
  assert.equal(typeof run.startedAt, "string");
  assert.equal(typeof run.finishedAt, "string");

  // a $0 dictionary run over the same corpus (for triangulation + dossiers)
  const dictStart = await ok("POST", `/api/projects/${S.slug}/runs`, {
    instrumentId: S.dictInstId,
    corpusId: S.corpusId,
  });
  S.dictRunId = dictStart.runId;
  const dictMon = await readSse(`/api/projects/${S.slug}/runs/${S.dictRunId}/monitor`);
  assert.equal(dictMon.events.find((e) => e.event === "done")?.data.status, "complete");
});

test("runs.js: escalations are output LINES {unitId, juror, label, escalated} (Director overrides marked escalatedBy — never a nested esc.director)", async () => {
  const esc = await ok("GET", `/api/projects/${S.slug}/runs/${S.judgeRunId}/escalations`);
  assert.ok(Array.isArray(esc), "escalations array");
  assert.ok(esc.length >= 1, `the long-unit predicate fired on the slice (${esc.length})`);
  for (const line of esc) {
    assert.equal(typeof line.unitId, "string");
    assert.equal(typeof line.juror, "string");
    assert.ok("label" in line);
    assert.equal(line.escalated, true);
    assert.equal(
      line.director,
      undefined,
      "no nested director object — overrides replace in place with escalatedBy",
    );
  }
});

// =========================================================================
// explorer.js — the descriptive analysis computed over a run
// =========================================================================

test("explorer.js: POST analyses {kind: descriptive, spec: {runId}} → results {prevalence [{label, count, share}], crosstabs [{by, table}], calibrationNudge} + evidence.cells", async () => {
  const a = await ok("POST", `/api/projects/${S.slug}/analyses`, {
    kind: "descriptive",
    spec: { runId: S.judgeRunId },
  });
  assert.equal(typeof a.id, "string");
  assert.equal(a.kind, "descriptive");
  assert.equal(typeof a.level, "string");
  assert.ok(a.evidence && typeof a.evidence.cells === "object", "evidence.cells map");

  const r = a.results;
  assert.ok(
    Array.isArray(r.prevalence) && r.prevalence.length > 0,
    "prevalence present when spec.runId rode the request",
  );
  for (const p of r.prevalence) {
    assert.equal(typeof p.label, "string");
    assert.equal(typeof p.count, "number");
    assert.equal(typeof p.share, "number");
  }
  assert.ok(Array.isArray(r.crosstabs), "crosstabs array");
  for (const xt of r.crosstabs) {
    assert.equal(typeof xt.by, "string");
    const t = xt.table;
    assert.ok(Array.isArray(t.rows) && Array.isArray(t.cols) && Array.isArray(t.matrix));
    assert.ok(Array.isArray(t.colTotals));
    assert.ok("chi2" in t && "df" in t);
  }
  // judge runs are single-label: no co-occurrence surface
  assert.equal(r.cooccurrence, undefined, "cooccurrence only for multilabel/panel runs");
  // nothing is calibrated yet → the nudge points at the construct
  assert.ok(r.calibrationNudge, "calibrationNudge present while instruments sit below calibrated");
  assert.equal(typeof r.calibrationNudge.constructName, "string");
  assert.equal(typeof r.calibrationNudge.estUnits, "number");
  assert.equal(typeof r.calibrationNudge.estMinutes, "number");
  // evidence doors: prevalence labels key into evidence.cells
  const someLabel = r.prevalence[0].label;
  assert.ok(Array.isArray(a.evidence.cells[someLabel]), `evidence.cells["${someLabel}"]`);
});

test("workbench.js deep links: GET analyses/:id serves the persisted artifact (deepEqual the POST result); missing id → 404", async () => {
  const created = await ok("POST", `/api/projects/${S.slug}/analyses`, {
    kind: "descriptive",
    spec: { runId: S.judgeRunId },
  });
  const got = await ok("GET", `/api/projects/${S.slug}/analyses/${created.id}`);
  assert.deepEqual(got, created, "the GET artifact deep-equals what POST returned");
  assert.deepEqual(got.results, created.results, "results round-trip exactly");
  const miss = await call("GET", `/api/projects/${S.slug}/analyses/an_does_not_exist`);
  assert.equal(miss.status, 404, "absent artifact → 404 (the screen keeps its recompute state)");
  assert.equal(miss.json?.error?.code, "NOT_FOUND");
});

// =========================================================================
// calibration.js — sample, blind coding, agreement nesting, adjudication
// =========================================================================

test("calibration.js: goldset create/get artifact; sample → {goldsetId, design, n, sample [{unitId, pi}]} (an envelope, not a bare array)", async () => {
  const gs = await ok("POST", `/api/projects/${S.slug}/goldsets`, {
    constructId: S.payConstructId,
    tier: "gold",
    corpusId: S.corpusId,
  });
  S.goldsetId = gs.id;
  assert.equal(gs.status, "sampling");
  assert.ok(Array.isArray(gs.sample) && Array.isArray(gs.coders));
  assert.equal(typeof gs.createdAt, "string");
  assert.equal(
    gs.disagreements,
    undefined,
    "no disagreements field — the screen derives the queue from coders+adjudicated",
  );

  const sampled = await ok("POST", `/api/projects/${S.slug}/goldsets/${S.goldsetId}/sample`, {
    design: "srs",
    n: 30,
  });
  assert.equal(Array.isArray(sampled), false, "sample response is an envelope");
  assert.equal(sampled.goldsetId, S.goldsetId);
  assert.equal(sampled.design, "srs");
  assert.equal(sampled.n, 30);
  assert.ok(Array.isArray(sampled.sample));
  assert.ok(
    sampled.sample.every((s) => typeof s.unitId === "string" && s.pi === 30 / 200),
    "π = n/N on every row",
  );
  S.goldIds = sampled.sample.map((s) => s.unitId);

  // the artifact the studio loads
  const loaded = await ok("GET", `/api/projects/${S.slug}/goldsets/${S.goldsetId}`);
  assert.equal(loaded.status, "coding");
  assert.equal(loaded.sample.length, 30);
  // project meta (goldsets list): metaOf shape with coders as ids
  const metas = await ok("GET", `/api/projects/${S.slug}/goldsets`);
  const meta = metas.find((g) => g.id === S.goldsetId);
  assert.ok(meta);
  assert.equal(meta.n, 30);
  assert.ok(Array.isArray(meta.coders));
  assert.equal(
    meta.name,
    "Gold — Pay complaint",
    "goldset metas carry the auto-name 'Gold — <construct>'",
  );
});

test("calibration.js: coder next view {unit {id, text, pos}, construct, progress}; label → progress {coderId, done, total, remaining, flagged}", async () => {
  const next = await ok(
    "GET",
    `/api/projects/${S.slug}/goldsets/${S.goldsetId}/next?coder=coder-A`,
  );
  assert.ok(next.unit && typeof next.unit.id === "string" && typeof next.unit.text === "string");
  assert.ok(next.construct && typeof next.construct.definition === "string");
  assert.ok(
    next.progress &&
      typeof next.progress.done === "number" &&
      typeof next.progress.total === "number",
  );

  // coder A codes planted truth; coder B flips the first 4 units
  S.flips = S.goldIds.slice(0, 4);
  for (const unitId of S.goldIds) {
    const truth = payTruth(S.units.get(unitId).text);
    const a = await ok("POST", `/api/projects/${S.slug}/goldsets/${S.goldsetId}/label`, {
      coder: "coder-A",
      unitId,
      label: truth,
    });
    assert.equal(typeof a.done, "number");
    assert.equal(typeof a.total, "number");
    assert.equal(typeof a.remaining, "number");
    assert.equal(typeof a.flagged, "number");
    const bLabel = S.flips.includes(unitId) ? (truth === "yes" ? "no" : "yes") : truth;
    await ok("POST", `/api/projects/${S.slug}/goldsets/${S.goldsetId}/label`, {
      coder: "coder-B",
      unitId,
      label: bLabel,
    });
  }
});

test("calibration.js: agreement report nests — humanAgreement {n, coders, percent, kappa, alpha, ac1} and perInstrument[].agreement.{kappa, perClass, confusion, labels} (NOT flat per-instrument stats)", async () => {
  armMock(0.9);
  const r = await ok("GET", `/api/projects/${S.slug}/goldsets/${S.goldsetId}/agreement`);

  const h = r.humanAgreement;
  assert.ok(h, "humanAgreement first");
  assert.equal(h.n, 30);
  assert.ok(Array.isArray(h.coders) && h.coders.length === 2);
  assert.equal(typeof h.percent, "number");
  assert.ok(Math.abs(h.percent - 26 / 30) < 1e-9, `po = 26/30 exactly (got ${h.percent})`);
  assert.ok("kappa" in h && "alpha" in h && "ac1" in h, "κ/α/AC1 on the human report");
  // the bootstrap CI rides the human report — {lo, hi, method}, percentile
  assert.ok(
    h.ci && typeof h.ci.lo === "number" && typeof h.ci.hi === "number",
    "bootstrap CI {lo, hi} on the live agreement report",
  );
  assert.equal(h.ci.method, "bootstrap-percentile");
  assert.ok(h.ci.lo <= h.alpha + 1e-9 && h.alpha <= h.ci.hi + 1e-9, "CI brackets the headline α");

  assert.ok(
    Array.isArray(r.perInstrument) && r.perInstrument.length >= 2,
    "judge + dictionary tested",
  );
  for (const inst of r.perInstrument) {
    assert.equal(typeof inst.instrumentId, "string");
    assert.equal(typeof inst.name, "string");
    assert.equal(typeof inst.kind, "string");
    assert.equal(typeof inst.level, "string");
    assert.equal(inst.kappa, undefined, "stats NEST under .agreement — never flat on the entry");
    if (inst.error) {
      assert.equal(typeof inst.error.message, "string");
      continue;
    }
    const a = inst.agreement;
    assert.ok(a, `${inst.name} carries a nested agreement report`);
    assert.equal(typeof a.n, "number");
    assert.equal(typeof a.percent, "number");
    assert.ok("kappa" in a && "alpha" in a && "ac1" in a);
    assert.ok(Array.isArray(a.perClass), "perClass (gold as reference coder)");
    for (const c of a.perClass) {
      assert.equal(typeof c.label, "string");
      for (const k of ["precision", "recall", "f1", "support"]) assert.ok(k in c);
    }
    assert.ok(Array.isArray(a.confusion), "confusion matrix");
    assert.ok(Array.isArray(a.labels), "confusion labels ride the agreement report");
  }
  const judge = r.perInstrument.find((x) => x.instrumentId === S.judgeInstId);
  assert.ok(judge && !judge.error, "the judge tested clean against gold");
  assert.ok(
    judge.agreement.percent > 0.7,
    `judge ≈ dialed accuracy (got ${judge.agreement.percent})`,
  );
  assert.equal(typeof r.goldLabeled, "number");
});

test("calibration.js: adjudicate → {status, adjudicated: count} (no `open` field); the derived disagreement queue closes and the goldset completes", async () => {
  for (const unitId of S.flips) {
    const res = await ok("POST", `/api/projects/${S.slug}/goldsets/${S.goldsetId}/adjudicate`, {
      unitId,
      label: payTruth(S.units.get(unitId).text),
    });
    assert.equal(typeof res.status, "string");
    assert.equal(typeof res.adjudicated, "number", "adjudicated is a count");
    assert.equal(res.open, undefined, "no `open` field — the screen derives it");
  }
  const gs = await ok("GET", `/api/projects/${S.slug}/goldsets/${S.goldsetId}`);
  assert.equal(gs.status, "complete");
  assert.equal(Object.keys(gs.adjudicated).length, 4);
  // the screen's derived queue: coders disagree on exactly the flipped units,
  // all resolved by the adjudications above
  const coders = gs.coders.filter((c) => Object.keys(c.labels ?? {}).length > 0);
  const derived = [];
  for (const s of gs.sample) {
    const labels = coders.map((c) => c.labels[s.unitId]).filter((v) => v !== undefined);
    if (labels.length >= 2 && new Set(labels.map(String)).size > 1) derived.push(s.unitId);
  }
  assert.deepEqual(
    derived.sort(),
    [...S.flips].sort(),
    "derived disagreement queue = the flipped units",
  );
});

test("instruments.js: freeze → certificate {frozenAt, goldsetId, agreement, humanAgreement, versionHash, modelPinned} — the certificateCard contract", async () => {
  armMock(0.9);
  const cert = await ok("POST", `/api/projects/${S.slug}/instruments/${S.judgeInstId}/freeze`, {
    goldsetId: S.goldsetId,
  });
  assert.equal(typeof cert.frozenAt, "string");
  assert.equal(cert.goldsetId, S.goldsetId);
  assert.equal(typeof cert.versionHash, "string");
  assert.equal(cert.modelPinned, true);
  assert.ok(
    cert.agreement &&
      "kappa" in cert.agreement &&
      "alpha" in cert.agreement &&
      "ac1" in cert.agreement,
  );
  assert.ok(Array.isArray(cert.agreement.perClass));
  assert.ok(cert.humanAgreement && typeof cert.humanAgreement.kappa === "number");

  const p = await getProject();
  const inst = p.instruments.find((i) => i.id === S.judgeInstId);
  assert.equal(inst.frozen, true);
  assert.equal(inst.level, "calibrated");
  assert.ok(inst.certificate, "certificate rides the instrument record");
});

// =========================================================================
// workbench.js — crosstab / model / subgroup / triangulation result shapes
// =========================================================================

test("workbench.js: crosstab spec {rowKey, colKey} → results.table {rows, cols, matrix, …, chi2, df, p, minExpected} + warnings + corrected cells [{group, n, est, se, ciLo, ciHi, naive}]", async () => {
  const a = await ok("POST", `/api/projects/${S.slug}/analyses`, {
    kind: "crosstab",
    spec: { rowKey: "label", colKey: "dept", runId: S.judgeRunId },
  });
  S.crosstabId = a.id;
  assert.equal(a.level, "corrected", "complete gold with π → ◉");
  const r = a.results;
  assert.equal(r.rows, undefined, "no flat results.rows — the table nests under results.table");
  const t = r.table;
  assert.ok(Array.isArray(t.rows) && Array.isArray(t.cols) && Array.isArray(t.matrix));
  assert.ok(Array.isArray(t.rowTotals) && Array.isArray(t.colTotals));
  assert.equal(typeof t.total, "number");
  assert.ok("chi2" in t && "df" in t && "p" in t, "χ² stats live ON the table");
  assert.equal(typeof t.minExpected, "number");
  assert.ok(Array.isArray(r.warnings), "warnings array (possibly empty)");
  for (const w of r.warnings) assert.equal(typeof w.message, "string");

  assert.equal(r.estimator, "dslProportion");
  assert.equal(r.groupBy, "dept");
  assert.equal(typeof r.positive, "string");
  assert.ok(Array.isArray(r.cells) && r.cells.length > 0, "corrected cells");
  for (const c of r.cells) {
    assert.equal(typeof c.group, "string");
    assert.equal(typeof c.n, "number");
    for (const k of ["est", "se", "ciLo", "ciHi"]) assert.equal(typeof c[k], "number", `cell.${k}`);
    assert.ok(c.naive && typeof c.naive.est === "number", "naive companion {est, …}");
  }
  // evidence doors key as `${label}|${group}`
  const keys = Object.keys(a.evidence.cells);
  assert.ok(
    keys.some((k) => k.includes("|")),
    `evidence cell keys are "row|col" pairs (${keys.slice(0, 4).join(", ")})`,
  );
});

test("workbench.js: model spec {x, family} → results {family, outcome, estimator, coef [{name, est, se}], naive, n, nGold} — no z/p columns", async () => {
  const a = await ok("POST", `/api/projects/${S.slug}/analyses`, {
    kind: "model",
    spec: { x: ["satisfaction"], family: "logit", runId: S.judgeRunId },
  });
  assert.equal(a.level, "corrected");
  const r = a.results;
  assert.equal(r.family, "logit");
  assert.equal(typeof r.outcome, "string");
  assert.equal(r.estimator, "dslLogit");
  assert.ok(Array.isArray(r.coef) && r.coef.length === 2, "intercept + satisfaction");
  for (const c of r.coef) {
    assert.equal(typeof c.name, "string");
    assert.equal(typeof c.est, "number");
    assert.equal(typeof c.se, "number");
    // DSL coefficient rows carry z/p — number, or null with a note when se = 0
    assert.ok(typeof c.z === "number" || c.z === null, `z is number|null (got ${c.z})`);
    assert.ok(typeof c.p === "number" || c.p === null, `p is number|null (got ${c.p})`);
    if (c.z === null) assert.equal(typeof c.note, "string", "null z carries its note");
  }
  assert.ok(Array.isArray(r.naive) && r.naive.length === 2, "naive fit beside the corrected one");
  for (const c of r.naive) assert.ok("est" in c && "se" in c);
  assert.equal(typeof r.n, "number");
  assert.equal(typeof r.nGold, "number");
  assert.equal(r.nUnits, undefined, "n, not nUnits");
});

test("workbench.js: subgroup audit (design §6.7) → results {by, overall {goldN, percentAgreement, kappa, errorRate}, groups [{group, n, dist, goldN, percentAgreement, kappa, errorRate, flagged}]} — agreement by group, flagged >0.1 below overall", async () => {
  const a = await ok("POST", `/api/projects/${S.slug}/analyses`, {
    kind: "subgroup",
    spec: { instrumentId: S.judgeInstId, by: "dept" },
  });
  const r = a.results;
  assert.equal(r.by, "dept");
  assert.equal(typeof r.positive, "string");

  // the overall machine-vs-gold reference the per-group flags compare against
  assert.ok(r.overall && typeof r.overall === "object", "overall agreement block");
  assert.equal(typeof r.overall.goldN, "number");
  assert.ok(r.overall.goldN > 0, "the complete gold set reaches this run");
  assert.equal(typeof r.overall.percentAgreement, "number");
  assert.equal(typeof r.overall.errorRate, "number");
  assert.ok(
    Math.abs(r.overall.errorRate - (1 - r.overall.percentAgreement)) < 2e-6,
    "errorRate complements agreement",
  );
  assert.ok(
    "kappa" in r.overall,
    "overall κ present (number, or null with a note when degenerate)",
  );

  assert.ok(Array.isArray(r.groups) && r.groups.length > 0);
  let withGold = 0;
  for (const g of r.groups) {
    assert.equal(typeof g.group, "string");
    assert.equal(typeof g.n, "number");
    assert.ok(g.dist && typeof g.dist === "object", "the label distribution stays (dist)");
    assert.equal(typeof g.goldN, "number");
    assert.equal(typeof g.flagged, "boolean");
    if (g.goldN === 0) {
      assert.equal(g.percentAgreement, null, "no gold in the group → agreement null");
      assert.equal(g.kappa, null);
      assert.equal(g.errorRate, null);
      assert.equal(g.flagged, false, "an unreadable group is never flagged");
      assert.equal(typeof g.note, "string", "the null carries its researcher-facing note");
    } else {
      withGold++;
      assert.equal(typeof g.percentAgreement, "number");
      assert.equal(typeof g.errorRate, "number");
      assert.ok(
        Math.abs(g.errorRate - (1 - g.percentAgreement)) < 2e-6,
        "per-group errorRate complements agreement",
      );
      assert.ok(typeof g.kappa === "number" || g.kappa === null, "κ is number|null");
      if (g.kappa === null) assert.equal(typeof g.note, "string", "degenerate κ carries its note");
      // THE flagged computation: >0.1 below the overall agreement
      assert.equal(
        g.flagged,
        r.overall.percentAgreement - g.percentAgreement > 0.1,
        `flag(${g.group}) = overall(${r.overall.percentAgreement}) − group(${g.percentAgreement}) > 0.1`,
      );
    }
    if (g.corrected) {
      assert.equal(typeof g.corrected.est, "number");
      assert.equal(typeof g.corrected.ciLo, "number");
    }
  }
  assert.ok(withGold > 0, "at least one group is auditable");
  // gold units partition over the groups — nothing double-counted or dropped
  assert.equal(
    r.groups.reduce((n, g) => n + g.goldN, 0),
    r.overall.goldN,
    "per-group goldN sums to overall goldN",
  );
});

test("workbench.js: triangulation spec {instrumentIds} → results {instruments, n, percentAgreement, kappa, divergent [{unitId, a, b}], pairs} — labels, not numeric points", async () => {
  const a = await ok("POST", `/api/projects/${S.slug}/analyses`, {
    kind: "triangulation",
    spec: { instrumentIds: [S.judgeInstId, S.dictInstId] },
  });
  const r = a.results;
  assert.ok(Array.isArray(r.instruments) && r.instruments.length === 2);
  for (const i of r.instruments) {
    assert.equal(typeof i.instrumentId, "string");
    assert.equal(typeof i.name, "string");
    assert.equal(typeof i.level, "string");
    assert.equal(typeof i.runId, "string");
  }
  assert.equal(typeof r.n, "number");
  assert.equal(typeof r.percentAgreement, "number");
  assert.ok("kappa" in r);
  assert.equal(r.points, undefined, "no numeric points array on live triangulation");
  assert.equal(r.pearson, undefined, "no pearson r either");
  assert.ok(Array.isArray(r.divergent));
  for (const d of r.divergent.slice(0, 5)) {
    assert.equal(typeof d.unitId, "string");
    assert.ok("a" in d && "b" in d, "divergent rows carry the two labels");
  }
  assert.ok(Array.isArray(r.pairs));
});

// =========================================================================
// evidence dossier — read by brief/calibration/workbench/disagreement + inspector
// =========================================================================

test("evidence dossier: {unit, dictionaryHits [{instrumentId, name, versionHash, hits}], outputs [{runId, …, outputs}], goldLabels ARRAY, sourcePos} — no top-level lang", async () => {
  const unitId = S.goldIds[0];
  const d = await ok("GET", `/api/projects/${S.slug}/evidence/${unitId}`);
  assert.equal(d.unit.id, unitId);
  assert.equal(typeof d.unit.text, "string");
  assert.equal(d.lang, undefined, "no top-level lang on the live dossier");

  assert.ok(Array.isArray(d.dictionaryHits));
  for (const dh of d.dictionaryHits) {
    assert.equal(typeof dh.instrumentId, "string");
    assert.equal(
      typeof dh.name,
      "string",
      "the wrapper carries the instrument NAME — the inspector's group label",
    );
    assert.equal(typeof dh.versionHash, "string");
    assert.ok(Array.isArray(dh.hits), "hit spans nest under .hits per instrument");
    for (const h of dh.hits) {
      assert.equal(typeof h.category, "string");
      assert.equal(typeof h.term, "string");
      assert.equal(typeof h.start, "number");
      assert.equal(typeof h.end, "number");
      assert.ok(h.end > h.start, "spans index the unit text");
    }
  }

  assert.ok(Array.isArray(d.outputs) && d.outputs.length >= 1, "outputs grouped by run");
  for (const o of d.outputs) {
    assert.equal(typeof o.runId, "string");
    assert.equal(typeof o.instrumentId, "string");
    assert.equal(typeof o.status, "string");
    assert.ok(Array.isArray(o.outputs));
    for (const line of o.outputs) {
      assert.equal(typeof line.juror, "string");
      assert.ok("label" in line);
    }
  }

  assert.ok(Array.isArray(d.goldLabels), "goldLabels is an ARRAY of per-goldset entries");
  const gl = d.goldLabels.find((g) => g.goldsetId === S.goldsetId);
  assert.ok(gl, "the gold set that sampled this unit appears");
  assert.equal(typeof gl.tier, "string");
  assert.equal(typeof gl.status, "string");
  assert.ok(gl.coders && typeof gl.coders === "object", "coder → label map");
  assert.ok("adjudicated" in gl);

  assert.ok(
    d.sourcePos && typeof d.sourcePos.row === "number",
    "source position rides the dossier",
  );
});

// =========================================================================
// disagreement.js — judge runs answer with the empty-but-shaped envelope
// =========================================================================

test("disagreement.js: GET runs/:r/disagreement → {byEntropy, jurorMatrix: {jurors, matrix}, note?} — matrix nests, labels are a juror→label map", async () => {
  const d = await ok("GET", `/api/projects/${S.slug}/runs/${S.judgeRunId}/disagreement`);
  assert.ok(Array.isArray(d.byEntropy), "byEntropy array");
  assert.ok(d.jurorMatrix && typeof d.jurorMatrix === "object", "jurorMatrix envelope");
  assert.ok(Array.isArray(d.jurorMatrix.jurors));
  assert.ok(Array.isArray(d.jurorMatrix.matrix));
  assert.equal(d.jurors, undefined, "no top-level jurors — they nest under jurorMatrix");
  // single-judge runs explain themselves
  assert.equal(d.byEntropy.length, 0);
  assert.equal(typeof d.note, "string", "the empty case carries a note the screen shows");
  for (const item of d.byEntropy) {
    assert.equal(typeof item.unitId, "string");
    assert.equal(typeof item.entropy, "number");
    assert.ok(item.labels && !Array.isArray(item.labels), "labels is a {juror: label} map");
  }
});

// =========================================================================
// reports.js — methods markdown + citations
// =========================================================================

test("reports.js: exports/methods → {analysisId, markdown, citations [{token, hash, type}]} — full hashes, 8-char tokens, no event objects", async () => {
  const r = await ok("GET", `/api/projects/${S.slug}/exports/methods?analysisId=${S.crosstabId}`);
  assert.equal(r.analysisId, S.crosstabId);
  assert.match(r.markdown, /^# Methods/);
  assert.ok(Array.isArray(r.citations) && r.citations.length > 0);
  for (const c of r.citations) {
    assert.match(c.token, /^ledger:[0-9a-f]{8}$/);
    assert.match(c.hash, /^[0-9a-f]{64}$/, "full chain hash");
    assert.equal(c.token.slice(7), c.hash.slice(0, 8), "token = 8-char hash prefix");
    assert.equal(typeof c.type, "string");
    assert.equal(c.event, undefined, "no embedded event object — the chip shows type + hash");
  }
  // every inline token resolves through the citations the screen maps by prefix
  const byPrefix = new Set(r.citations.map((c) => c.hash.slice(0, 8)));
  const tokens = [...r.markdown.matchAll(/\[ledger:([0-9a-f]{8})\]/g)].map((m) => m[1]);
  assert.ok(tokens.length >= 5, `claims carry citations (${tokens.length})`);
  for (const tok of tokens) assert.ok(byPrefix.has(tok), `token ${tok} resolves`);
});

// =========================================================================
// reports.js canvas + workbench.js addToReport — the persisted report layout
// =========================================================================

test("report canvas: PUT /report echoes {blocks: ARRAY, updatedAt}; project.report.blocks round-trips for the canvas seed; POST /report/blocks → {blocks: COUNT} + addedAt stamp; unknown kind → 400 VALIDATION; blocks: [] clears", async () => {
  // One block of each kind the validator accepts (REPORT_BLOCK_KINDS), written
  // in exactly the shapes the client persists: workbench.js addToReport sends
  // {kind, ref, title, level} for chart/table; reports.js addBlockSheet sends
  // {kind, ref, title} quotes, {kind, content} text, {kind, title} methods.
  const five = [
    { kind: "chart", ref: S.crosstabId, title: "Pay × dept", level: "corrected" },
    { kind: "table", ref: S.crosstabId, title: "Pay × dept (table)", level: "corrected" },
    { kind: "quote", ref: S.goldIds[0], title: `quote · ${S.goldIds[0].slice(0, 12)}` },
    { kind: "text", content: "Compensation dominates the corpus." },
    { kind: "methods-excerpt", title: "methods excerpt" },
  ];

  // PUT replaces the whole layout; the response IS the report object — the
  // canvas assigns it straight onto the cached project graph (reports.js
  // persist(): cached.report = saved), so blocks must be the ARRAY, not a count
  const saved = await ok("PUT", `/api/projects/${S.slug}/report`, { blocks: five });
  assert.ok(
    Array.isArray(saved.blocks),
    "PUT echoes blocks as an ARRAY — the canvas caches it as project.report",
  );
  assert.equal(saved.blocks.length, 5);
  assert.deepEqual(
    saved.blocks.map((b) => b.kind),
    ["chart", "table", "quote", "text", "methods-excerpt"],
    "all five kinds the validator accepts persist",
  );
  assert.deepEqual(
    saved.blocks,
    five,
    "PUT echoes the blocks exactly as sent — no addedAt stamping on replace",
  );
  assert.equal(typeof saved.updatedAt, "string");
  assert.ok(
    Number.isFinite(Date.parse(saved.updatedAt)),
    `updatedAt is ISO-parseable (got ${saved.updatedAt})`,
  );

  // the project GET — THE read reports.js seeds its canvas from
  // (store.set("report.blocks", project.report?.blocks ?? []))
  let p = await getProject();
  assert.ok(
    p.report && typeof p.report === "object",
    "project.report rides the full project graph",
  );
  assert.equal(p.report.blocks.length, 5, "round-trip: same length");
  assert.deepEqual(
    p.report.blocks.map((b) => b.kind),
    five.map((b) => b.kind),
    "kinds preserved in order",
  );
  assert.deepEqual(
    p.report.blocks,
    five,
    "every field intact ({kind, ref?, content?, title?, level?}) — the read the canvas opens with",
  );
  assert.equal(p.report.updatedAt, saved.updatedAt);

  // POST appends ONE block (the workbench "Add to report" action) → {blocks:
  // COUNT}, a NUMBER — workbench.js toasts `${updated.blocks} blocks now`
  const sixth = {
    kind: "chart",
    ref: S.crosstabId,
    title: "appended from workbench",
    level: "corrected",
  };
  const appended = await ok("POST", `/api/projects/${S.slug}/report/blocks`, { block: sixth });
  assert.equal(appended.blocks, 6, "POST answers {blocks: <count>} — a number, never the array");
  p = await getProject();
  assert.equal(p.report.blocks.length, 6);
  const added = p.report.blocks[5];
  assert.equal(added.kind, "chart", "the appended block lands at the end");
  assert.equal(added.ref, sixth.ref);
  assert.equal(added.title, sixth.title);
  assert.equal(added.level, sixth.level);
  assert.equal(
    typeof added.addedAt,
    "string",
    "the append path stamps addedAt for the canvas's recency display",
  );
  assert.ok(
    Number.isFinite(Date.parse(added.addedAt)),
    `addedAt is ISO-parseable (got ${added.addedAt})`,
  );
  assert.equal(
    p.report.blocks[0].addedAt,
    undefined,
    "PUT-replaced blocks carry NO addedAt — only the append stamps",
  );

  // unknown kind → 400 VALIDATION (same negative pattern as the analyses 404):
  // the canvas must never persist a block the exporter cannot draw
  const bad = await call("PUT", `/api/projects/${S.slug}/report`, {
    blocks: [{ kind: "sparkle" }],
  });
  assert.equal(bad.status, 400, "unknown block kind rejects");
  assert.equal(bad.json?.error?.code, "VALIDATION");
  assert.match(bad.json.error.message, /sparkle/, "the error names the offending kind");
  p = await getProject();
  assert.equal(p.report.blocks.length, 6, "a rejected PUT leaves the saved layout untouched");

  // blocks: [] — the "remove everything" path (the canvas's last × click)
  const cleared = await ok("PUT", `/api/projects/${S.slug}/report`, { blocks: [] });
  assert.deepEqual(cleared.blocks, [], "an empty layout is a valid replacement");
  assert.equal(typeof cleared.updatedAt, "string");
  p = await getProject();
  assert.equal(p.report.blocks.length, 0, "GET shows the cleared canvas");
});

// =========================================================================
// main.js question bar — the plan sheet contract
// =========================================================================

test("questionbar (main.js plan sheet): ask → {planId, plan {constructs, instruments [{constructId, constructName, workerClass, provider, model}], estimate {usd, etaMin, calls}, analysis {kind, spec, annotation}}}; approve → {planId, constructIds, instrumentIds, runIds}", async () => {
  armMock(0.9);
  const res = await ok("POST", `/api/projects/${S.slug}/questionbar`, {
    question: "Which departments complain most about pay?",
    corpusId: S.corpusId,
  });
  assert.equal(typeof res.planId, "string");
  const plan = res.plan;
  assert.equal(plan.authoredBy, "director");
  assert.ok(Array.isArray(plan.constructs) && plan.constructs.length >= 1);
  for (const c of plan.constructs) {
    assert.equal(typeof c.name, "string");
    assert.equal(typeof c.type, "string");
    assert.equal(typeof c.definition, "string");
  }
  assert.ok(Array.isArray(plan.instruments) && plan.instruments.length >= 1);
  for (const i of plan.instruments) {
    assert.equal(typeof i.constructId, "string");
    assert.equal(typeof i.constructName, "string");
    assert.equal(typeof i.workerClass, "string");
    assert.equal(typeof i.provider, "string");
    assert.equal(typeof i.model, "string");
    // flagged in the audit report: the live spec carries NO name/kind —
    // main.js renders blanks for those two reads
    assert.equal(i.name, undefined);
    assert.equal(i.kind, undefined);
  }
  assert.equal(typeof plan.estimate.usd, "number");
  assert.equal(typeof plan.estimate.etaMin, "number");
  assert.equal(typeof plan.estimate.calls, "number");
  assert.equal(typeof plan.analysis.kind, "string");
  assert.ok(
    plan.analysis.spec && typeof plan.analysis.spec === "object",
    "analysis.spec is an object",
  );
  assert.equal(typeof plan.analysis.annotation, "string");

  const approved = await ok("POST", `/api/projects/${S.slug}/questionbar/${res.planId}/approve`);
  assert.equal(approved.planId, res.planId);
  assert.ok(Array.isArray(approved.constructIds) && approved.constructIds.length >= 1);
  assert.ok(Array.isArray(approved.instrumentIds) && approved.instrumentIds.length >= 1);
  assert.ok(
    Array.isArray(approved.runIds) && approved.runIds.length >= 1,
    "a pending run per instrument",
  );

  const p = await getProject();
  assert.equal(p.plans.find((x) => x.planId === res.planId)?.status, "approved");
  for (const id of approved.runIds) {
    assert.equal(p.runs.find((r2) => r2.id === id)?.status, "pending");
  }
});

// =========================================================================
// settings.js — keys envelope, health booleans (run LAST: the keys PUT
// clears the adapter cache and disarms the scripted mock)
// =========================================================================

test("settings.js: GET /api/settings → {keys: {name: {configured, apiKey?, baseUrl?}}, port}; health → {ok, version, providers: {name: bool}}; PUT {keys} masks and echoes", async () => {
  const h = await call("GET", "/api/health");
  assert.equal(h.status, 200);
  assert.equal(h.json.ok, true);
  assert.equal(typeof h.json.version, "string");
  assert.ok(h.json.providers && typeof h.json.providers === "object");
  for (const name of ["anthropic", "openai", "openrouter", "ollama", "mock"]) {
    assert.equal(typeof h.json.providers[name], "boolean", `${name} reachability boolean`);
  }

  const s = await ok("GET", "/api/settings");
  assert.ok(s.keys && typeof s.keys === "object", "keys map (may be empty)");
  assert.equal(typeof s.port, "number");
  assert.equal(s.providers, undefined, "no rich providers map — cards compose keys + health");
  assert.equal(s.director, undefined, "no global director — the slot is a project field");

  const updated = await ok("PUT", "/api/settings", {
    keys: { anthropic: "sk-shapes-test-key-12345" },
  });
  assert.ok(Array.isArray(updated.keysUpdated) && updated.keysUpdated.includes("anthropic"));
  const entry = updated.keys.anthropic;
  assert.equal(entry.configured, true);
  assert.equal(typeof entry.apiKey, "string");
  assert.ok(!entry.apiKey.includes("shapes-test"), `key is masked (got ${entry.apiKey})`);
});
