// Task J — performance budgets (design §10), asserted through the REAL
// product paths: HTTP import → confirm, the Instant Read endpoint, and a
// full-corpus dictionary run through the run engine. Budgets are deliberately
// generous (CI machines vary wildly); the tight numbers are LOGGED so a
// regression is visible long before a budget trips.
//
//   import 10k rows (upload + parse + mapping + confirm/unitize/junk) < 10s
//   Instant Read compute on the 10k corpus                            < 30s
//   dictionary run over the committed 2,500-row demo corpus (engine)  < 10s
//
// Keyless throughout; the 10k corpus is generated in-test from the demo
// generator's exported function (seeded — deterministic content, no files).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startServer } from "../../server/index.js";
import { getAdapter } from "../../server/providers/registry.js";
import { generate, toCsv } from "../../demo/generate.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let tmpProjects;
let tmpConfig;
let srv;
let base;

before(async () => {
  tmpProjects = await mkdtemp(path.join(os.tmpdir(), "concord-perf-"));
  tmpConfig = await mkdtemp(path.join(os.tmpdir(), "concord-perf-cfg-"));
  process.env.CONCORD_PROJECTS_DIR = tmpProjects;
  process.env.CONCORD_CONFIG_DIR = tmpConfig;
  srv = await startServer({ port: 0 });
  base = `http://127.0.0.1:${srv.port}`;
  for (const name of ["openrouter", "ollama"]) {
    getAdapter({ privacyMode: "open" }, name).adapter.catalog = async () => [];
  }
});

after(async () => {
  await srv.close();
  delete process.env.CONCORD_PROJECTS_DIR;
  delete process.env.CONCORD_CONFIG_DIR;
  await rm(tmpProjects, { recursive: true, force: true }).catch(() => {});
  await rm(tmpConfig, { recursive: true, force: true }).catch(() => {});
});

async function ok(method, p, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + p, init);
  const json = JSON.parse(await res.text());
  assert.equal(res.status, 200, `${method} ${p} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  assert.equal(json.ok, true);
  return json.data;
}

async function upload(p, filename, content) {
  const form = new FormData();
  form.append("file", new Blob([content]), filename);
  const res = await fetch(base + p, { method: "POST", body: form });
  const json = JSON.parse(await res.text());
  assert.equal(res.status, 200, `upload → ${res.status}`);
  return json.data;
}

async function readSse(p) {
  const res = await fetch(base + p);
  const text = await res.text();
  const events = [];
  for (const block of text.split(/\n\n/)) {
    let event = "message";
    const data = [];
    for (const line of block.split(/\n/)) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      else if (line.startsWith("data: ")) data.push(line.slice(6));
    }
    if (data.length) events.push({ event, data: JSON.parse(data.join("\n")) });
  }
  return events;
}

const S = { slug: "perf-project", corpus10k: null, demoCorpus: null };

test("perf: 10k-row import through HTTP (upload + mapping + confirm) < 10s", async () => {
  await ok("POST", "/api/projects", { name: "Perf Project", privacyMode: "open" });

  // 10k variant straight from the demo generator (seeded; in-memory only)
  const t0gen = performance.now();
  const { rows } = generate({ n: 10000, seed: 4242 });
  const csv = toCsv(rows);
  const genMs = performance.now() - t0gen;

  const t0 = performance.now();
  const up = await upload(`/api/projects/${S.slug}/import`, "perf-10k.csv", csv);
  const responseCol = up.mapping.columns.find((c) => c.name === "response");
  assert.equal(responseCol.role, "text");
  const confirmed = await ok("POST", `/api/projects/${S.slug}/import/confirm`, {
    importId: up.importId,
    mapping: { textColumn: "response" },
    unitization: { scheme: "response" },
  });
  const ms = performance.now() - t0;
  S.corpus10k = confirmed.corpusId;

  assert.equal(confirmed.unitCount, 10000);
  console.log(`    perf: 10k-row import end-to-end ${ms.toFixed(0)}ms (csv ${(csv.length / 1024 / 1024).toFixed(1)}MB, generated in ${genMs.toFixed(0)}ms)`);
  assert.ok(ms < 10_000, `10k import budget 10s, took ${ms.toFixed(0)}ms`);
});

test("perf: Instant Read compute on the 10k corpus < 30s", async () => {
  const t0 = performance.now();
  const r = await ok("GET", `/api/projects/${S.slug}/corpora/${S.corpus10k}/instantread`);
  const ms = performance.now() - t0;

  assert.equal(r.local, true);
  assert.equal(r.unitCount, 10000);
  assert.ok(r.topTerms.length > 0 && r.lengthHist.bins.length > 0, "real surfaces computed");
  console.log(`    perf: Instant Read on 10k units ${ms.toFixed(0)}ms`);
  assert.ok(ms < 30_000, `Instant Read budget 30s on 10k rows, took ${ms.toFixed(0)}ms`);
});

test("perf: full-corpus dictionary run via the engine on the demo corpus (2,500 units) < 10s", async () => {
  // the COMMITTED demo corpus, through the same import the demo uses
  const csv = await readFile(path.join(repoRoot, "demo", "techcorp-exit-survey.csv"), "utf8");
  const up = await upload(`/api/projects/${S.slug}/import`, "techcorp-exit-survey.csv", csv);
  const confirmed = await ok("POST", `/api/projects/${S.slug}/import/confirm`, {
    importId: up.importId,
    mapping: { textColumn: "response" },
    unitization: { scheme: "response" },
  });
  S.demoCorpus = confirmed.corpusId;
  assert.equal(confirmed.unitCount, 2500);

  const construct = await ok("POST", `/api/projects/${S.slug}/constructs`, {
    name: "Pay language",
    type: "binary",
    definition: "The unit uses compensation vocabulary.",
    criteria: { include: ["pay/salary/compensation terms"], exclude: [] },
    categories: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
  });
  const inst = await ok("POST", `/api/projects/${S.slug}/instruments`, {
    constructId: construct.id,
    kind: "dictionary",
    name: "Pay dictionary",
    payload: {
      categories: [{
        name: "pay",
        terms: [
          { term: "pay" }, { term: "pay*" }, { term: "salar*" }, { term: "compensation" },
          { term: "underpaid" }, { term: "raise" }, { term: "bonus" }, { term: "wage*" },
        ],
      }],
      negation: { enabled: false, window: 3 },
      scoring: "count",
    },
  });

  // engine path: createRun → executeRun (checkpointing, outputs.ndjson,
  // monitor) — the whole persistence pipeline, not just dictionary.score
  const t0 = performance.now();
  const { runId } = await ok("POST", `/api/projects/${S.slug}/runs`, {
    instrumentId: inst.id,
    corpusId: S.demoCorpus,
  });
  const evs = await readSse(`/api/projects/${S.slug}/runs/${runId}/monitor`);
  const ms = performance.now() - t0;
  const done = evs.find((e) => e.event === "done");
  assert.equal(done?.data.status, "complete");
  assert.deepEqual(done.data.checkpoint, { done: 2500, total: 2500 });

  // the planted vocabulary actually fires: roughly the pay base rate
  const analysis = await ok("POST", `/api/projects/${S.slug}/analyses`, {
    kind: "descriptive",
    spec: { runId },
  });
  const yes = analysis.results.prevalence.find((p) => p.label === "yes");
  assert.ok(yes && yes.share > 0.15 && yes.share < 0.45,
    `dictionary sees the planted pay vocabulary (${JSON.stringify(yes)})`);

  console.log(`    perf: dictionary engine run over 2,500 demo units ${ms.toFixed(0)}ms ($${done.data.cost?.actualUSD ?? 0})`);
  assert.ok(ms < 10_000, `dictionary engine-run budget 10s, took ${ms.toFixed(0)}ms`);
});
