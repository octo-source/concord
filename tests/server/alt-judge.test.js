// Alternate judges on the stability check, end to end over HTTP:
//   1. POST instruments/:i/stability accepts `models: [{provider, model,
//      snapshot?}, …]` (≤4, judge instruments only) and, AFTER the normal k
//      reruns, runs each alternate ONCE over the SAME sampled units with the
//      instrument's same compiled prompt/params/schema — only provider/model/
//      snapshot overridden. The artifact gains alts: [{provider, model,
//      labels} | {provider, model, error}]; the response gains alts:
//      [{provider, model, n} | {provider, model, error}]. alpha/pass stay
//      own-model-reruns-only.
//   2. GET reliability/:constructId emits one source per successful alt —
//      key alt:<instrumentId>:<provider>/<model>, label "<name> — alt judge
//      <model>", kind "alt" — riding the same generic pairwise loop (alt-vs-
//      alt, alt-vs-retest, alt-vs-gold). Errored alts become a functional
//      note; a different corpus yields no alt sources.
//   3. No models field → artifact has NO alts key, response is wave-1 {alpha,
//      pass}; a failing alternate never sinks the check.
//
// Harness mirrors tests/server/retest-reliability.test.js: real server on an
// ephemeral port, temp CONCORD_PROJECTS_DIR/CONCORD_CONFIG_DIR, MockModel
// with a deterministic oracle at accuracy 1.0 (mock stability reruns get
// distinct seeds; distinct alt models decorrelate by model id). Tests run
// serially in declaration order and share state via S.
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

const ORACLE = (text) => (String(text).includes("salary") ? "yes" : "no");

before(async () => {
  tmpProjects = await mkdtemp(path.join(os.tmpdir(), "concord-altjudge-"));
  tmpConfig = await mkdtemp(path.join(os.tmpdir(), "concord-altjudge-cfg-"));
  process.env.CONCORD_PROJECTS_DIR = tmpProjects;
  process.env.CONCORD_CONFIG_DIR = tmpConfig;
  srv = await startServer({ port: 0 });
  base = `http://127.0.0.1:${srv.port}`;
  // network-backed catalogs must not leave the machine during tests
  for (const name of ["openrouter", "ollama"]) {
    const { adapter } = getAdapter({ privacyMode: "open" }, name);
    adapter.catalog = async () => [];
  }
  // deterministic worker: oracle-pinned at accuracy 1.0 (alternates included)
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

async function fail(method, p, body, status, code) {
  const r = await call(method, p, body);
  assert.equal(
    r.status,
    status,
    `${method} ${p} expected ${status}, got ${r.status}: ${r.text?.slice(0, 300)}`,
  );
  assert.equal(r.json?.ok, false);
  if (code)
    assert.equal(r.json.error.code, code, `expected error code ${code}, got ${r.json.error.code}`);
  return r.json.error;
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
async function readSse(p) {
  const res = await fetch(base + p);
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

// ----------------------------------------------------------------- corpora

// Every row padded to one fixed length: no unit exceeds the p99 length
// escalation predicate, and the oracle splits rows into yes/no by parity.
function makeCsv(rows, tag) {
  const lines = ["respondent_id,dept,response"];
  for (let i = 0; i < rows; i++) {
    const text = (
      i % 2 === 0
        ? `the salary is too low for this ${tag} work and it never improves (${i})`
        : `the office is comfortable and the ${tag} team is genuinely kind (${i})`
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
  corpusA: null, // the stability corpus (also has a complete run → inst: source)
  corpusB: null, // a different corpus — alt rows must NOT leak onto it
  constructId: null,
  instId: null,
  dictId: null, // a dictionary instrument — alternates must be refused
  baseAlpha: null, // no-alts run results, pinned for the with-alts comparison
  baseReruns: null,
  unitIds: null, // the sampled unit ids from the artifact
};

const K = 3;
const N = 12;

const ALT_A = { provider: "mock", model: "mock-alpha" };
const ALT_B = { provider: "mock", model: "mock-beta" };

const artifactFile = () => path.join(projectDir(S.slug), "stability", `${S.instId}.json`);
const stabilityUrl = () => `/api/projects/${S.slug}/instruments/${S.instId}/stability`;
const altKey = (m) => `alt:${S.instId}:${m.provider}/${m.model}`;

// =========================================================================
// (d) no models field → wave-1-identical response and artifact
// =========================================================================

test("stability without models: response is exactly {alpha, pass}; artifact carries NO alts key", async () => {
  const project = await ok("POST", "/api/projects", { name: "Alt Judge Demo" });
  S.slug = project.slug;

  const up = await upload(`/api/projects/${S.slug}/import`, "exit-a.csv", makeCsv(30, "alpha"));
  const conf = await ok("POST", `/api/projects/${S.slug}/import/confirm`, {
    importId: up.importId,
    mapping: { textColumn: "response" },
    unitization: { scheme: "response" },
  });
  S.corpusA = conf.corpusId;

  const construct = await ok("POST", `/api/projects/${S.slug}/constructs`, {
    name: "Pay complaint",
    type: "binary",
    definition: "The unit complains about compensation.",
    categories: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
  });
  S.constructId = construct.id;

  const inst = await ok("POST", `/api/projects/${S.slug}/instruments`, {
    constructId: S.constructId,
    kind: "judge",
    name: "Pay judge",
    payload: judgePayload(),
  });
  S.instId = inst.id;

  // a complete run on corpus A → the inst: source alt rows pair with
  const started = await ok("POST", `/api/projects/${S.slug}/runs`, {
    instrumentId: S.instId,
    corpusId: S.corpusA,
  });
  const { events } = await readSse(`/api/projects/${S.slug}/runs/${started.runId}/monitor`);
  assert.equal(events.find((e) => e.event === "done")?.data.status, "complete", "run completes");

  const r = await ok("POST", stabilityUrl(), { k: K, n: N, corpusId: S.corpusA });
  // the response grew the additive `level` field (the instrument's level
  // AFTER the check — tests/server/stability-honesty.test.js pins it);
  // otherwise the wave-1 shape stands
  assert.deepEqual(
    Object.keys(r).sort(),
    ["alpha", "level", "pass"],
    "response shape: {alpha, level, pass} and nothing else",
  );
  assert.equal(r.alpha, 1, "accuracy-1.0 oracle is perfectly stable");
  assert.equal(r.pass, true);
  assert.equal(r.level, "exploratory", "a pass without silver evidence never promotes");

  const art = JSON.parse(await readFile(artifactFile(), "utf8"));
  assert.ok(!("alts" in art), "no models requested → no alts key in the artifact");
  assert.equal(art.reruns.length, K);
  S.baseAlpha = r.alpha;
  S.baseReruns = art.reruns;
  S.unitIds = art.unitIds;
});

// =========================================================================
// (a) two alternates: same sampled units labeled once each; reruns/alpha
//     semantics identical to the no-alts run; response lists alts with n
// =========================================================================

test("stability with two alternates: artifact alts label the same sampled units; reruns and alpha identical to the no-alts run; response lists {provider, model, n}", async () => {
  const r = await ok("POST", stabilityUrl(), {
    k: K,
    n: N,
    corpusId: S.corpusA,
    models: [ALT_A, ALT_B],
  });
  assert.equal(r.alpha, S.baseAlpha, "alpha is own-model reruns only — alternates never move it");
  assert.equal(r.pass, true);
  assert.deepEqual(
    r.alts,
    [
      { provider: "mock", model: "mock-alpha", n: N },
      { provider: "mock", model: "mock-beta", n: N },
    ],
    "response alts carry the label count per alternate",
  );

  const art = JSON.parse(await readFile(artifactFile(), "utf8"));
  // unitIds are arrival-ordered (cache hits land faster than fresh calls);
  // the SAMPLE — the set — is what the seed pins
  assert.deepEqual([...art.unitIds].sort(), [...S.unitIds].sort(), "same seeded sample");
  assert.equal(art.alpha, S.baseAlpha);
  assert.equal(art.reruns.length, S.baseReruns.length, "still k reruns");
  for (const [i, rerun] of art.reruns.entries()) {
    assert.equal(rerun.index, S.baseReruns[i].index);
    assert.deepEqual(
      rerun.labels,
      S.baseReruns[i].labels,
      `rerun ${rerun.index} labels are unchanged by alternates (cached, same seeds)`,
    );
  }
  assert.equal(art.alts.length, 2, "one alts entry per requested model");
  for (const [i, alt] of art.alts.entries()) {
    const want = [ALT_A, ALT_B][i];
    assert.equal(alt.provider, want.provider);
    assert.equal(alt.model, want.model);
    assert.ok(!("error" in alt), "successful alternates carry no error");
    assert.deepEqual(
      Object.keys(alt.labels).sort(),
      [...art.unitIds].sort(),
      `alt ${alt.model} labels exactly the sampled units`,
    );
    for (const label of Object.values(alt.labels)) {
      assert.ok(["yes", "no"].includes(label), `label "${label}" is a schema value`);
    }
  }

  // the instrument's own stability summary: wave-1 fields plus corpusId
  // (the header chip links the right reliability matrix) — no alt leakage
  const p = await ok("GET", `/api/projects/${S.slug}`);
  const inst = p.instruments.find((i) => i.id === S.instId);
  assert.deepEqual(
    Object.keys(inst.stability).sort(),
    ["alpha", "corpusId", "k", "n", "ranAt"],
    "instrument.stability summary shape: wave-1 + corpusId, no alt leakage",
  );
  assert.equal(inst.stability.alpha, 1);
});

// =========================================================================
// (b) reliability: alt sources with the pinned key/label/kind; pairs ride
//     the generic loop — alt×alt, alt×retest, alt×gold
// =========================================================================

test("reliability: alt:<id>:<provider>/<model> sources with pinned labels and kind alt; alt×alt, alt×retest and alt×gold pairs", async () => {
  // gold over exactly the sampled units: TWO coders labeling oracle-true make
  // every sampled unit a consensus gold label (the consensus rule requires
  // ≥2 unanimous label votes — a single coder's vote is not gold), so gold
  // overlaps the alternates on all N units.
  const lines = (
    await readFile(path.join(projectDir(S.slug), "corpora", S.corpusA, "units.ndjson"), "utf8")
  )
    .split(/\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const textById = new Map(lines.map((u) => [u.id, u.text]));

  const gs = await ok("POST", `/api/projects/${S.slug}/goldsets`, {
    constructId: S.constructId,
    corpusId: S.corpusA,
  });
  for (const unitId of S.unitIds) {
    await ok("POST", `/api/projects/${S.slug}/goldsets/${gs.id}/queue`, { unitId });
    for (const coder of ["coder-A", "coder-B"]) {
      await ok("POST", `/api/projects/${S.slug}/goldsets/${gs.id}/label`, {
        coder,
        unitId,
        label: ORACLE(textById.get(unitId)),
      });
    }
  }

  const rel = await ok(
    "GET",
    `/api/projects/${S.slug}/reliability/${S.constructId}?corpusId=${S.corpusA}`,
  );
  const keys = rel.sources.map((s) => s.key);
  for (const m of [ALT_A, ALT_B]) {
    assert.ok(
      keys.includes(altKey(m)),
      `source ${altKey(m)} present (got ${JSON.stringify(keys)})`,
    );
  }
  const a1 = rel.sources.find((s) => s.key === altKey(ALT_A));
  assert.equal(a1.kind, "alt");
  assert.equal(a1.label, "Pay judge — alt judge mock-alpha", "pinned label format");
  assert.equal(a1.n, N, "n is the alternate's label count");

  assert.ok(keys.includes("gold"), "the gold source assembled from the queue+label recipe");

  const pairOf = (a, b) => rel.pairs.find((x) => [x.a, x.b].includes(a) && [x.a, x.b].includes(b));

  const altAlt = pairOf(altKey(ALT_A), altKey(ALT_B));
  assert.ok(altAlt, "alt × alt pair present");
  assert.equal(altAlt.n, N);
  assert.equal(altAlt.percent, 1, "oracle-pinned alternates agree perfectly");

  const altRetest = pairOf(altKey(ALT_A), `retest:${S.instId}:1`);
  assert.ok(altRetest, "alt × retest pair present");
  assert.equal(altRetest.n, N, "overlap is the stability sample");
  assert.equal(altRetest.percent, 1);

  const altGold = pairOf(altKey(ALT_A), "gold");
  assert.ok(altGold, "alt × gold pair present");
  assert.equal(altGold.n, N);
  assert.equal(altGold.percent, 1, "accuracy-1.0 alternates match the oracle gold");

  const altInst = pairOf(altKey(ALT_B), `inst:${S.instId}`);
  assert.ok(altInst, "alt × inst pair rides the same generic loop");
  assert.equal(altInst.percent, 1);
});

// =========================================================================
// (c) corpus mismatch: no alt sources on the other corpus
// =========================================================================

test("reliability: stability artifact for a different corpus → no alt sources, no alt-failure notes", async () => {
  const up = await upload(`/api/projects/${S.slug}/import`, "exit-b.csv", makeCsv(14, "beta"));
  const conf = await ok("POST", `/api/projects/${S.slug}/import/confirm`, {
    importId: up.importId,
    mapping: { textColumn: "response" },
    unitization: { scheme: "response" },
  });
  S.corpusB = conf.corpusId;

  const rel = await ok(
    "GET",
    `/api/projects/${S.slug}/reliability/${S.constructId}?corpusId=${S.corpusB}`,
  );
  assert.ok(
    !rel.sources.some((s) => String(s.key).startsWith("alt:")),
    "no alt sources on the other corpus",
  );
  assert.ok(
    !rel.notes.some((n) => /alternate judge/i.test(n)),
    "no alt notes either — the different-corpus note covers discovery",
  );
  assert.ok(
    rel.notes.includes(
      "A stability check exists for Pay judge on a different corpus. Run the stability check on this corpus to see rerun rows.",
    ),
    `the wave-1 different-corpus note still stands (got ${JSON.stringify(rel.notes)})`,
  );
});

// =========================================================================
// (e) validation: >4 models, non-judge instruments, malformed entries
// =========================================================================

test("validation: five models → VALIDATION", async () => {
  const five = Array.from({ length: 5 }, (_, i) => ({ provider: "mock", model: `mock-${i}` }));
  await fail(
    "POST",
    stabilityUrl(),
    { k: K, n: N, corpusId: S.corpusA, models: five },
    400,
    "VALIDATION",
  );
});

test("validation: models on a dictionary instrument → VALIDATION naming judge instruments", async () => {
  const dict = await ok("POST", `/api/projects/${S.slug}/instruments`, {
    constructId: S.constructId,
    kind: "dictionary",
    name: "Pay dictionary",
    payload: {
      categories: [{ name: "pay", terms: [{ term: "salary" }] }],
      negation: { enabled: false, window: 3 },
      scoring: "percentOfWords",
    },
  });
  S.dictId = dict.id;
  const err = await fail(
    "POST",
    `/api/projects/${S.slug}/instruments/${S.dictId}/stability`,
    {
      k: K,
      n: N,
      corpusId: S.corpusA,
      models: [ALT_A],
    },
    400,
    "VALIDATION",
  );
  assert.match(
    err.message,
    /judge instruments/i,
    "the message says alternate judges apply to judge instruments",
  );
});

test("validation: malformed models entries → VALIDATION", async () => {
  // not an array
  await fail(
    "POST",
    stabilityUrl(),
    { k: K, n: N, corpusId: S.corpusA, models: "mock" },
    400,
    "VALIDATION",
  );
  // entry missing model
  await fail(
    "POST",
    stabilityUrl(),
    { k: K, n: N, corpusId: S.corpusA, models: [{ provider: "mock" }] },
    400,
    "VALIDATION",
  );
  // entry with empty provider
  await fail(
    "POST",
    stabilityUrl(),
    { k: K, n: N, corpusId: S.corpusA, models: [{ provider: "", model: "mock-2" }] },
    400,
    "VALIDATION",
  );
  // entry not a plain object
  await fail(
    "POST",
    stabilityUrl(),
    { k: K, n: N, corpusId: S.corpusA, models: [["mock", "mock-2"]] },
    400,
    "VALIDATION",
  );
});

// =========================================================================
// (f) a failing alternate never sinks the check
// =========================================================================

test("failing alternate: recorded as {provider, model, error}; the other alternate's labels intact; reliability carries the failure note", async () => {
  const BAD = { provider: "nope", model: "ghost" }; // unknown provider → deterministic adapter error
  const r = await ok("POST", stabilityUrl(), {
    k: K,
    n: N,
    corpusId: S.corpusA,
    models: [ALT_A, BAD],
  });
  assert.equal(r.alpha, S.baseAlpha, "the check itself completes with the same alpha");
  assert.equal(r.pass, true);
  assert.equal(r.alts.length, 2);
  assert.deepEqual(
    r.alts[0],
    { provider: "mock", model: "mock-alpha", n: N },
    "the healthy alternate is unaffected",
  );
  assert.equal(r.alts[1].provider, "nope");
  assert.equal(r.alts[1].model, "ghost");
  assert.match(
    r.alts[1].error,
    /unknown provider "nope"/,
    "the provider error is recorded, not thrown",
  );
  assert.ok(
    !("n" in r.alts[1]) && !("labels" in r.alts[1]),
    "an errored alternate carries no labels",
  );

  const art = JSON.parse(await readFile(artifactFile(), "utf8"));
  assert.equal(art.alts.length, 2);
  assert.deepEqual(
    Object.keys(art.alts[0].labels).sort(),
    [...art.unitIds].sort(),
    "healthy alt labels intact",
  );
  assert.match(art.alts[1].error, /unknown provider "nope"/);
  assert.ok(!("labels" in art.alts[1]));

  const rel = await ok(
    "GET",
    `/api/projects/${S.slug}/reliability/${S.constructId}?corpusId=${S.corpusA}`,
  );
  const keys = rel.sources.map((s) => s.key);
  assert.ok(keys.includes(altKey(ALT_A)), "the healthy alternate is a source");
  assert.ok(!keys.includes(`alt:${S.instId}:nope/ghost`), "the errored alternate is NOT a source");
  assert.ok(
    rel.notes.includes(
      'Alternate judge ghost failed during the stability check: unknown provider "nope".',
    ),
    `the pinned failure note is present (got ${JSON.stringify(rel.notes)})`,
  );
});
