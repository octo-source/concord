// Stability-surface honesty, end to end over HTTP:
//   1. POST instruments/:i/stability returns the instrument's level AFTER
//      the check ({alpha, pass, level, alts?}): a pass on a never-silver-
//      tuned judge stays "exploratory" (silver evidence + pass together mark
//      ◑); once silver evidence exists the same passing check promotes and
//      the response says "stabilized"; frozen instruments skip persistence
//      and report their unchanged level.
//   2. The stability artifact records the instrument's versionHash at check
//      time. GET reliability/:constructId compares it to the CURRENT hash:
//      after an edit, retest/alt source labels gain " (earlier version)" and
//      ONE note says to rerun; artifacts without the field (pre-versionHash
//      servers) are treated as current — no marker, no note.
//   3. GET reliability?corpusId=X returns the retest/alt sources for X (the
//      corpus-pinned links from the instruments screen land on the rows).
//
// Harness mirrors tests/server/retest-reliability.test.js: real server on an
// ephemeral port, temp CONCORD_PROJECTS_DIR/CONCORD_CONFIG_DIR, MockModel
// with a deterministic oracle at accuracy 1.0. Tests run serially in
// declaration order and share state via S. Silver evidence and the frozen
// flag are planted through the store module (same process, same files) —
// the route only reads inst.silver truthiness and inst.frozen.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startServer } from "../../server/index.js";
import { getAdapter } from "../../server/providers/registry.js";
import { projectDir, updateProject } from "../../server/core/store.js";

// ---------------------------------------------------------------- harness

let tmpProjects;
let tmpConfig;
let srv;
let base;

const ORACLE = (text) => (String(text).includes("salary") ? "yes" : "no");

before(async () => {
  tmpProjects = await mkdtemp(path.join(os.tmpdir(), "concord-sthonesty-"));
  tmpConfig = await mkdtemp(path.join(os.tmpdir(), "concord-sthonesty-cfg-"));
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

const judgePayload = (template) => ({
  provider: "mock",
  model: "mock-1",
  snapshot: "mock-1",
  params: { temperature: 0, maxTokens: 64 },
  promptTemplate: template ?? "Judge the unit. {{definition}} {{criteria}} {{examples}} {{unit}}",
  schema: { type: "binary", options: ["yes", "no"] },
  rationaleFirst: true,
  workerClass: "frontier",
});

// ------------------------------------------------------------ shared state

const S = {
  slug: null,
  corpusA: null,
  constructId: null,
  instId: null, // the silver-promotion + staleness instrument ("Pay judge")
  inst2Id: null, // the frozen instrument ("Frozen judge")
  checkHash: null, // instId's versionHash at stability-check time
};

const K = 3;
const N = 12;

const ALT = { provider: "mock", model: "mock-gamma" };

const artifactFile = (instId) => path.join(projectDir(S.slug), "stability", `${instId}.json`);
const stabilityUrl = (instId) => `/api/projects/${S.slug}/instruments/${instId}/stability`;
const reliabilityUrl = () =>
  `/api/projects/${S.slug}/reliability/${S.constructId}?corpusId=${S.corpusA}`;

const STALE_NOTE = (name) =>
  `The stability check for ${name} ran on an earlier version of the instrument — rerun it to refresh.`;

// =========================================================================
// (1) level honesty: a pass without silver evidence stays exploratory
// =========================================================================

test("stability: never-silver-tuned judge passes → response {alpha, pass, level: exploratory}; no promotion persisted; artifact stamps versionHash", async () => {
  const project = await ok("POST", "/api/projects", { name: "Stability Honesty Demo" });
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

  const r = await ok("POST", stabilityUrl(S.instId), { k: K, n: N, corpusId: S.corpusA });
  assert.deepEqual(
    Object.keys(r).sort(),
    ["alpha", "level", "pass"],
    "response shape: {alpha, level, pass} and nothing else",
  );
  assert.equal(r.alpha, 1, "accuracy-1.0 oracle is perfectly stable");
  assert.equal(r.pass, true);
  assert.equal(
    r.level,
    "exploratory",
    "a passing check WITHOUT silver evidence must not claim promotion — the route promotes only when inst.silver exists",
  );

  const p = await ok("GET", `/api/projects/${S.slug}`);
  const persisted = p.instruments.find((i) => i.id === S.instId);
  assert.equal(persisted.level, "exploratory", "no promotion persisted either");
  assert.equal(persisted.stability.alpha, 1, "the summary still lands on the instrument");
  assert.equal(persisted.stability.n, N, "summary n is the actual sample size");

  // fix 9a: the artifact records the compiled prompt the check actually ran
  const art = JSON.parse(await readFile(artifactFile(S.instId), "utf8"));
  assert.equal(
    art.versionHash,
    persisted.versionHash,
    "artifact.versionHash is the instrument's hash at check time",
  );
  S.checkHash = art.versionHash;
});

// =========================================================================
// (2) after silver evidence exists, the same passing check promotes
// =========================================================================

test("stability: once silver evidence exists, a passing check promotes → response level stabilized; alt rides along", async () => {
  // plant silver evidence directly through the store (same process, same
  // files) — the route's promotion gate reads inst.silver truthiness only
  await updateProject(S.slug, (p) => {
    const inst = p.instruments.find((x) => x.id === S.instId);
    inst.silver = {
      goldsetId: "gs_planted",
      iterations: [
        { versionHash: inst.versionHash, agreement: 0.95, kappa: 0.9, alpha: 0.9, note: "planted" },
      ],
    };
  });

  const r = await ok("POST", stabilityUrl(S.instId), {
    k: K,
    n: N,
    corpusId: S.corpusA,
    models: [ALT],
  });
  assert.equal(r.pass, true);
  assert.equal(r.level, "stabilized", "silver evidence + passing check together mark ◑");
  assert.deepEqual(
    r.alts,
    [{ provider: "mock", model: "mock-gamma", n: N }],
    "the alternate labeled the sample",
  );

  const p = await ok("GET", `/api/projects/${S.slug}`);
  assert.equal(
    p.instruments.find((i) => i.id === S.instId).level,
    "stabilized",
    "promotion persisted",
  );
});

// =========================================================================
// (3) frozen: no persistence, the response reports the unchanged level
// =========================================================================

test("stability: frozen instrument → response level is the unchanged level; nothing persists onto the instrument; artifact still written", async () => {
  const inst2 = await ok("POST", `/api/projects/${S.slug}/instruments`, {
    constructId: S.constructId,
    kind: "judge",
    name: "Frozen judge",
    payload: judgePayload("Frozen reading. {{definition}} {{criteria}} {{examples}} {{unit}}"),
  });
  S.inst2Id = inst2.id;
  // plant the frozen state directly (the freeze route needs the full gold
  // flow; the stability route only reads inst.frozen and inst.level)
  await updateProject(S.slug, (p) => {
    const inst = p.instruments.find((x) => x.id === S.inst2Id);
    inst.frozen = true;
    inst.level = "calibrated";
    inst.certificate = {
      frozenAt: new Date().toISOString(),
      goldsetId: "gs_planted",
      versionHash: inst.versionHash,
      modelPinned: true,
    };
  });

  const r = await ok("POST", stabilityUrl(S.inst2Id), { k: K, n: N, corpusId: S.corpusA });
  assert.equal(r.pass, true);
  assert.equal(
    r.level,
    "calibrated",
    "frozen instruments report their unchanged level — never a ◑ claim",
  );

  const p = await ok("GET", `/api/projects/${S.slug}`);
  const persisted = p.instruments.find((i) => i.id === S.inst2Id);
  assert.equal(persisted.level, "calibrated", "level untouched");
  assert.equal(persisted.stability, undefined, "frozen instruments skip the summary persistence");

  const art = JSON.parse(await readFile(artifactFile(S.inst2Id), "utf8"));
  assert.equal(
    art.versionHash,
    persisted.versionHash,
    "the artifact is still written (reliability reads it)",
  );
});

// =========================================================================
// (4) staleness: edit after the check → " (earlier version)" labels + ONE note
// =========================================================================

test("reliability: instrument edited after its stability check → retest AND alt labels carry ' (earlier version)', exactly one rerun-to-refresh note; corpusId query returns the rows", async () => {
  const v2 = await ok("PUT", `/api/projects/${S.slug}/instruments/${S.instId}`, {
    payload: judgePayload(
      "Edited after the check. {{definition}} {{criteria}} {{examples}} {{unit}}",
    ),
  });
  assert.notEqual(v2.versionHash, S.checkHash, "the edit re-versioned the instrument");

  const rel = await ok("GET", reliabilityUrl());
  assert.equal(rel.corpusId, S.corpusA, "the corpus-pinned link's query is honored");
  assert.equal(rel.retestAvailable, true);

  for (let i = 1; i <= K; i++) {
    const src = rel.sources.find((s) => s.key === `retest:${S.instId}:${i}`);
    assert.ok(src, `retest:${S.instId}:${i} present for the queried corpus`);
    assert.equal(
      src.label,
      `Pay judge — rerun ${i} of ${K} (earlier version)`,
      "stale rerun rows say which version they measured",
    );
  }
  const altSrc = rel.sources.find((s) => s.key === `alt:${S.instId}:mock/mock-gamma`);
  assert.ok(altSrc, "the alt source from the same artifact is present");
  assert.equal(
    altSrc.label,
    "Pay judge — alt judge mock-gamma (earlier version)",
    "stale alt rows carry the same marker",
  );

  const staleNotes = rel.notes.filter((n) => n === STALE_NOTE("Pay judge"));
  assert.equal(
    staleNotes.length,
    1,
    `exactly ONE note per stale artifact (got ${JSON.stringify(rel.notes)})`,
  );

  // the frozen instrument was NOT edited — its rows stay unmarked
  const frozenRerun = rel.sources.find((s) => s.key === `retest:${S.inst2Id}:1`);
  assert.ok(frozenRerun, "the frozen instrument's reruns are sources too");
  assert.equal(
    frozenRerun.label,
    `Frozen judge — rerun 1 of ${K}`,
    "a matching versionHash gets no marker",
  );
  assert.ok(!rel.notes.includes(STALE_NOTE("Frozen judge")), "and no note");
});

// =========================================================================
// (5) back-compat: artifacts without versionHash are treated as current
// =========================================================================

test("reliability: pre-versionHash artifact (field absent) → no marker, no note", async () => {
  const file = artifactFile(S.instId);
  const art = JSON.parse(await readFile(file, "utf8"));
  delete art.versionHash;
  await writeFile(file, JSON.stringify(art));

  const rel = await ok("GET", reliabilityUrl());
  const r1 = rel.sources.find((s) => s.key === `retest:${S.instId}:1`);
  assert.ok(r1, "the rows still show");
  assert.equal(
    r1.label,
    `Pay judge — rerun 1 of ${K}`,
    "no false staleness alarm on old artifacts",
  );
  assert.ok(
    !rel.sources.some((s) => String(s.label).includes("(earlier version)")),
    "no source anywhere carries the marker",
  );
  assert.ok(
    !rel.notes.some((n) => n.includes("earlier version")),
    `no rerun-to-refresh note (got ${JSON.stringify(rel.notes)})`,
  );
});
