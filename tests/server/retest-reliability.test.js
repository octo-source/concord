// Test–retest reliability, end to end over HTTP:
//   1. POST instruments/:i/stability persists a per-rerun artifact at
//      projects/<slug>/stability/<instrumentId>.json — {id, instrumentId,
//      constructId, corpusId, k, n, alpha, unitIds, reruns:[{index, labels}],
//      createdAt} — alongside the summary it already writes onto the
//      instrument (back-compat);
//   2. GET reliability/:constructId reads that artifact back as ordinary
//      sources keyed retest:<instrumentId>:<index> (label "<name> — rerun
//      <i> of <k>") that flow through the same generic pairwise loop, with
//      retestAvailable: true;
//   3. a stability artifact for a DIFFERENT corpus yields no sources, just
//      the functional note; no artifact at all yields today's exact shape.
//
// Harness mirrors tests/unit/routes.test.js: real server on an ephemeral
// port, temp CONCORD_PROJECTS_DIR/CONCORD_CONFIG_DIR, MockModel worker with
// a deterministic oracle at accuracy 1.0 (reruns agree perfectly → α = 1).
// Tests run serially in declaration order and share state via S.
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
  tmpProjects = await mkdtemp(path.join(os.tmpdir(), "concord-retest-"));
  tmpConfig = await mkdtemp(path.join(os.tmpdir(), "concord-retest-cfg-"));
  process.env.CONCORD_PROJECTS_DIR = tmpProjects;
  process.env.CONCORD_CONFIG_DIR = tmpConfig;
  srv = await startServer({ port: 0 });
  base = `http://127.0.0.1:${srv.port}`;
  // network-backed catalogs must not leave the machine during tests
  for (const name of ["openrouter", "ollama"]) {
    const { adapter } = getAdapter({ privacyMode: "open" }, name);
    adapter.catalog = async () => [];
  }
  // deterministic worker: oracle-pinned at accuracy 1.0
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
  corpusB: null, // a different corpus — retest rows must NOT leak onto it
  constructId: null,
  construct2Id: null, // never stability-checked → today's exact shape
  instId: null,
};

const K = 3;
const N = 12;

const artifactFile = () => path.join(projectDir(S.slug), "stability", `${S.instId}.json`);

// =========================================================================
// (a) stability run persists the per-rerun artifact at the pinned path
// =========================================================================

test("stability: persists projects/<slug>/stability/<instrumentId>.json with k 1-based reruns, sampled-unit labels and the summary alpha", async () => {
  const project = await ok("POST", "/api/projects", { name: "Retest Demo" });
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

  // a complete run on corpus A → the inst: source the retest rows pair with
  const started = await ok("POST", `/api/projects/${S.slug}/runs`, {
    instrumentId: S.instId,
    corpusId: S.corpusA,
  });
  const { events } = await readSse(`/api/projects/${S.slug}/runs/${started.runId}/monitor`);
  assert.equal(events.find((e) => e.event === "done")?.data.status, "complete", "run completes");

  const r = await ok("POST", `/api/projects/${S.slug}/instruments/${S.instId}/stability`, {
    k: K,
    n: N,
    corpusId: S.corpusA,
  });
  assert.equal(r.alpha, 1, "accuracy-1.0 oracle is perfectly stable");
  assert.equal(r.pass, true);

  const art = JSON.parse(await readFile(artifactFile(), "utf8"));
  assert.match(art.id, /^st_/);
  assert.equal(art.instrumentId, S.instId);
  assert.equal(art.constructId, S.constructId);
  assert.equal(art.corpusId, S.corpusA);
  assert.equal(art.k, K);
  assert.equal(art.n, N);
  assert.equal(art.alpha, r.alpha, "artifact carries the same summary alpha the route returned");
  assert.ok(Array.isArray(art.unitIds), "unitIds is an array");
  assert.equal(art.unitIds.length, N, "the n sampled unit ids are recorded");
  assert.equal(art.reruns.length, K, "one entry per rerun");
  assert.deepEqual(
    art.reruns.map((x) => x.index),
    [1, 2, 3],
    "rerun indexes are 1-based",
  );
  for (const rerun of art.reruns) {
    assert.deepEqual(
      Object.keys(rerun.labels).sort(),
      [...art.unitIds].sort(),
      "each rerun labels exactly the sampled units",
    );
    for (const label of Object.values(rerun.labels)) {
      assert.ok(["yes", "no"].includes(label), `label "${label}" is a schema value`);
    }
  }
  assert.ok(!Number.isNaN(Date.parse(art.createdAt)), "createdAt is ISO8601");
});

// =========================================================================
// (b) reliability surfaces the reruns as ordinary pairwise sources
// =========================================================================

test("reliability: retest:<id>:1..k sources with the pinned labels; retest×retest AND retest×inst pairs; retestAvailable true", async () => {
  const rel = await ok(
    "GET",
    `/api/projects/${S.slug}/reliability/${S.constructId}?corpusId=${S.corpusA}`,
  );
  assert.equal(rel.retestAvailable, true);

  const keys = rel.sources.map((s) => s.key);
  for (let i = 1; i <= K; i++) {
    assert.ok(keys.includes(`retest:${S.instId}:${i}`), `source retest:${S.instId}:${i} present`);
  }
  const r1 = rel.sources.find((s) => s.key === `retest:${S.instId}:1`);
  assert.equal(r1.kind, "retest");
  assert.equal(r1.label, `Pay judge — rerun 1 of ${K}`, "pinned label format");
  assert.equal(r1.n, N, "n is the count of labels in that rerun");

  const pairOf = (a, b) => rel.pairs.find((x) => [x.a, x.b].includes(a) && [x.a, x.b].includes(b));

  // every rerun×rerun combination rides the generic pairwise loop
  for (let i = 1; i <= K; i++) {
    for (let j = i + 1; j <= K; j++) {
      const p = pairOf(`retest:${S.instId}:${i}`, `retest:${S.instId}:${j}`);
      assert.ok(p, `retest ${i} × retest ${j} pair present`);
      assert.equal(p.n, N);
      assert.equal(p.percent, 1, "oracle-pinned reruns agree perfectly");
    }
  }
  // ...and reruns pair with the instrument's own corpus run
  for (let i = 1; i <= K; i++) {
    const p = pairOf(`inst:${S.instId}`, `retest:${S.instId}:${i}`);
    assert.ok(p, `inst × retest ${i} pair present`);
    assert.equal(p.n, N, "overlap is the stability sample");
    assert.equal(p.percent, 1);
  }
});

// =========================================================================
// (c) a different corpus: no retest rows, the functional note instead
// =========================================================================

test("reliability: stability artifact for a different corpus → no retest sources, retestAvailable false, functional note", async () => {
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
  assert.equal(rel.retestAvailable, false);
  assert.ok(
    !rel.sources.some((s) => String(s.key).startsWith("retest:")),
    "no retest sources on the other corpus",
  );
  assert.ok(
    rel.notes.includes(
      "A stability check exists for Pay judge on a different corpus. Run the stability check on this corpus to see rerun rows.",
    ),
    `the functional note names the instrument (got ${JSON.stringify(rel.notes)})`,
  );
});

// =========================================================================
// (d) no stability ever run: exactly today's response
// =========================================================================

test("reliability: construct never stability-checked → retestAvailable false, no retest sources, no retest/stability note", async () => {
  const c2 = await ok("POST", `/api/projects/${S.slug}/constructs`, {
    name: "Team praise",
    type: "binary",
    definition: "The unit praises the team.",
    categories: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
  });
  S.construct2Id = c2.id;

  const rel = await ok(
    "GET",
    `/api/projects/${S.slug}/reliability/${S.construct2Id}?corpusId=${S.corpusA}`,
  );
  assert.deepEqual(
    Object.keys(rel).sort(),
    ["constructId", "corpusId", "notes", "pairs", "retestAvailable", "sources"],
    "response shape is unchanged",
  );
  assert.equal(rel.retestAvailable, false);
  assert.ok(!rel.sources.some((s) => String(s.key).startsWith("retest:")), "no retest sources");
  assert.ok(
    !rel.notes.some((n) => /retest|stability/i.test(n)),
    `no retest/stability note when none was run (got ${JSON.stringify(rel.notes)})`,
  );
});

// =========================================================================
// (e) the instrument summary stat persists exactly as before
// =========================================================================

test("stability: instrument.stability summary {alpha, k, n, ranAt} still persists onto the instrument", async () => {
  const p = await ok("GET", `/api/projects/${S.slug}`);
  const inst = p.instruments.find((i) => i.id === S.instId);
  assert.ok(inst.stability, "summary present");
  assert.equal(inst.stability.alpha, 1);
  assert.equal(inst.stability.k, K);
  assert.equal(inst.stability.n, N);
  assert.ok(!Number.isNaN(Date.parse(inst.stability.ranAt)), "ranAt is ISO8601");
});
