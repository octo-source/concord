// Gold-set destruction guards. A gold set accumulates committed human work
// (per-coder labels + uncodable marks, adjudications, exclusions); resampling
// or deleting over that work must demand explicit confirmation:
//
//   POST  …/goldsets/:g/sample  body {force: true}   — else 409 CONFIRM_REQUIRED
//   DELETE …/goldsets/:id?force=1                     — else 409 CONFIRM_REQUIRED
//
// The 409 body carries the real counts {labels, coders, adjudicated, excluded}
// so the client can state exactly what would be discarded. A forced resample
// CLEARS the stale work (otherwise orphaned labels corrupt agreement
// statistics) and ledgers the discard as goldset.resampled. Fresh gold sets
// (no committed work) behave exactly as before — no confirmation.
//
// Harness mirrors tests/unit/routes.test.js: real server on an ephemeral port
// over temp CONCORD_PROJECTS_DIR/CONCORD_CONFIG_DIR; tests run serially in
// declaration order and share state via S. No provider needed — goldset
// create/sample/label/adjudicate are all local.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startServer } from "../../server/index.js";
import { projectDir } from "../../server/core/store.js";
import * as ledger from "../../server/core/ledger.js";

// ---------------------------------------------------------------- harness

let tmpProjects;
let tmpConfig;
let srv;
let base;

before(async () => {
  tmpProjects = await mkdtemp(path.join(os.tmpdir(), "concord-goldguard-"));
  tmpConfig = await mkdtemp(path.join(os.tmpdir(), "concord-goldguard-cfg-"));
  process.env.CONCORD_PROJECTS_DIR = tmpProjects;
  process.env.CONCORD_CONFIG_DIR = tmpConfig;
  srv = await startServer({ port: 0 });
  base = `http://127.0.0.1:${srv.port}`;
});

after(async () => {
  await srv.close();
  delete process.env.CONCORD_PROJECTS_DIR;
  delete process.env.CONCORD_CONFIG_DIR;
  await rm(tmpProjects, { recursive: true, force: true }).catch(() => {});
  await rm(tmpConfig, { recursive: true, force: true }).catch(() => {});
});

async function call(method, p, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + p, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
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
  return json.data;
}

function makeCsv() {
  // 40 rows of comfortably-long text so the response column detects as text
  const lines = ["respondent_id,response"];
  for (let i = 0; i < 40; i++) {
    const text = i % 3 === 0
      ? "the salary is too low for this work and it never improves around here"
      : "the office is comfortable and the team is genuinely kind to everyone";
    lines.push(`r${i},${text}`);
  }
  return lines.join("\n") + "\n";
}

// ------------------------------------------------------------ shared state

const S = {
  slug: null,
  corpusId: null,
  constructId: null,
  goldsetId: null, // the worked goldset (labels + adjudications + exclusion)
  units: [], // sample unitIds of the worked goldset
};

const G = (rest = "") => `/api/projects/${S.slug}/goldsets${rest}`;
const goldsetArtifact = (id) => path.join(tmpProjects, S.slug, "gold", `${id}.json`);
// the exact committed work planted in the setup test below
const PLANTED = { labels: 10, coders: 2, adjudicated: 2, excluded: 1 };

// ---------------------------------------------------------------- the tests

test("setup: project + corpus + construct + a goldset carrying committed work", async () => {
  const project = await ok("POST", "/api/projects", { name: "Guard Project", privacyMode: "open" });
  S.slug = project.slug;

  const up = await upload(`/api/projects/${S.slug}/import`, "survey.csv", makeCsv());
  const confirmed = await ok("POST", `/api/projects/${S.slug}/import/confirm`, {
    importId: up.importId,
    mapping: { textColumn: "response" },
    unitization: { scheme: "response" },
  });
  S.corpusId = confirmed.corpusId;
  assert.equal(confirmed.unitCount, 40);

  const construct = await ok("POST", `/api/projects/${S.slug}/constructs`, {
    name: "Pay complaint",
    type: "binary",
    definition: "The unit complains about compensation level or fairness.",
    criteria: { include: ["names compensation as a problem"], exclude: ["benefits-only complaints"] },
    edgeCases: [],
    examples: [
      { text: "What they pay us is insulting.", label: "yes", kind: "positive" },
      { text: "Great team, decent comp.", label: "no", kind: "negative" },
    ],
    categories: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
  });
  S.constructId = construct.id;

  const gs = await ok("POST", G(), { constructId: S.constructId, tier: "gold", corpusId: S.corpusId });
  S.goldsetId = gs.id;
  const sampled = await ok("POST", G(`/${gs.id}/sample`), { design: "srs", n: 10 });
  assert.equal(sampled.n, 10, "a FRESH goldset samples without any confirmation");
  S.units = sampled.sample.map((s) => s.unitId);

  // committed work: coder-A labels 5; coder-B labels 4 + 1 uncodable
  // (totalLabels 10 across 2 coders); 2 adjudications; 1 exclusion.
  for (const u of S.units.slice(0, 5)) {
    await ok("POST", G(`/${gs.id}/label`), { coder: "coder-A", unitId: u, label: "yes" });
  }
  for (const u of S.units.slice(0, 4)) {
    await ok("POST", G(`/${gs.id}/label`), { coder: "coder-B", unitId: u, label: "no" });
  }
  await ok("POST", G(`/${gs.id}/label`), { coder: "coder-B", unitId: S.units[4], uncodable: true });
  // persist a human agreement report too — stale κ over discarded labels must
  // not survive a forced resample
  await ok("GET", G(`/${gs.id}/agreement`));
  await ok("POST", G(`/${gs.id}/adjudicate`), { unitId: S.units[0], label: "yes" });
  await ok("POST", G(`/${gs.id}/adjudicate`), { unitId: S.units[1], label: "no" });
  await ok("POST", G(`/${gs.id}/adjudicate`), { unitId: S.units[5], exclude: true });

  const full = await ok("GET", G(`/${S.goldsetId}`));
  assert.equal(Object.keys(full.adjudicated ?? {}).length, 2);
  assert.equal((full.excluded ?? []).length, 1);
});

test("(a) sample over committed work without force → 409 CONFIRM_REQUIRED with exact counts; nothing is touched", async () => {
  const err = await fail("POST", G(`/${S.goldsetId}/sample`), { design: "srs", n: 10 }, 409, "CONFIRM_REQUIRED");
  assert.deepEqual(err.details, PLANTED, "detail carries the exact committed-work counts");
  assert.match(err.message, /10 human labels/, "message states the real label count");
  assert.match(err.message, /2 coders/, "message states the real coder count");
  assert.match(err.message, /2 adjudications/, "message states the real adjudication count");

  // the refused attempt destroyed nothing
  const full = await ok("GET", G(`/${S.goldsetId}`));
  const coderA = full.coders.find((c) => c.coderId === "coder-A");
  assert.equal(Object.keys(coderA.labels).length, 5, "coder-A's labels survive the refusal");
  assert.equal(Object.keys(full.adjudicated ?? {}).length, 2, "adjudications survive the refusal");
  assert.equal((full.excluded ?? []).length, 1, "exclusions survive the refusal");
});

test("(b) sample with force: true → 200, new sample drawn, all committed work cleared from the artifact", async () => {
  const res = await ok("POST", G(`/${S.goldsetId}/sample`), { design: "srs", n: 8, force: true });
  assert.equal(res.n, 8, "the forced resample draws the requested n");

  // assert on the artifact ON DISK — the clearing must be persisted
  const artifact = JSON.parse(await readFile(goldsetArtifact(S.goldsetId), "utf8"));
  assert.equal(artifact.sample.length, 8);
  assert.ok(artifact.coders.length >= 2, "coder entries remain (identities are history)");
  for (const c of artifact.coders) {
    assert.deepEqual(c.labels ?? {}, {}, `${c.coderId} labels emptied`);
    assert.deepEqual(c.uncodable ?? {}, {}, `${c.coderId} uncodable marks emptied`);
    assert.deepEqual(c.memos ?? {}, {}, `${c.coderId} memos emptied`);
    assert.deepEqual(c.flagged ?? [], [], `${c.coderId} flags emptied`);
  }
  assert.deepEqual(artifact.adjudicated ?? {}, {}, "adjudications emptied");
  assert.deepEqual(artifact.excluded ?? [], [], "exclusions emptied");
  assert.equal(artifact.humanAgreement, undefined, "stale human-agreement report dropped with the labels it measured");
  assert.equal(artifact.status, "coding", "the normal sample flow's status transition still runs");
});

test("(f) the forced resample is ledgered as goldset.resampled with the discarded counts", async () => {
  const pdir = projectDir(S.slug);
  const events = await ledger.query(pdir, { type: "goldset.resampled", ref: S.goldsetId });
  assert.equal(events.length, 1, "exactly one goldset.resampled event");
  assert.equal(events[0].actor, "human");
  assert.deepEqual(events[0].payload.discarded, PLANTED, "the event records what was discarded");
  // the new draw still appends the normal goldset.sampled event
  const sampled = await ledger.query(pdir, { type: "goldset.sampled", ref: S.goldsetId });
  assert.equal(sampled.length, 2, "initial draw + forced redraw both ledgered as goldset.sampled");
});

test("(c) delete over committed work without force → 409 CONFIRM_REQUIRED; the goldset survives", async () => {
  // recommit work on the (now clean) goldset: one coder, three labels
  const full = await ok("GET", G(`/${S.goldsetId}`));
  for (const s of full.sample.slice(0, 3)) {
    await ok("POST", G(`/${S.goldsetId}/label`), { coder: "coder-C", unitId: s.unitId, label: "yes" });
  }

  const err = await fail("DELETE", G(`/${S.goldsetId}`), undefined, 409, "CONFIRM_REQUIRED");
  assert.deepEqual(err.details, { labels: 3, coders: 1, adjudicated: 0, excluded: 0 });

  const still = await ok("GET", G(`/${S.goldsetId}`));
  assert.equal(still.id, S.goldsetId, "the goldset survives the refused delete");
});

test("(d) delete with ?force=1 → 200; goldset gone from the project and the artifact file removed", async () => {
  const r = await ok("DELETE", G(`/${S.goldsetId}?force=1`));
  assert.equal(r.deleted, S.goldsetId);

  await fail("GET", G(`/${S.goldsetId}`), undefined, 404, "NOT_FOUND");
  const list = await ok("GET", G());
  assert.ok(!list.some((g) => g.id === S.goldsetId), "project meta no longer lists the goldset");
  await assert.rejects(stat(goldsetArtifact(S.goldsetId)), { code: "ENOENT" }, "artifact file removed from disk");
});

test("(e) fresh goldsets keep the old behavior: sample, resample, and delete all work without force", async () => {
  const gs = await ok("POST", G(), { constructId: S.constructId, tier: "gold", corpusId: S.corpusId });
  const first = await ok("POST", G(`/${gs.id}/sample`), { design: "srs", n: 10 });
  assert.equal(first.n, 10, "first draw needs no confirmation");
  // a sample EXISTS now, but no human work is committed — resampling stays free
  const second = await ok("POST", G(`/${gs.id}/sample`), { design: "srs", n: 12 });
  assert.equal(second.n, 12, "resampling an uncoded goldset needs no confirmation");
  const r = await ok("DELETE", G(`/${gs.id}`));
  assert.equal(r.deleted, gs.id, "deleting an uncoded goldset needs no confirmation");
});
