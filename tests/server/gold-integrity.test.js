// Gold-pipeline integrity — the consensus rule and its blast radius:
//
//   1. CONSENSUS GOLD: a unit is gold when adjudicated, OR when ≥2 coders
//      cast identical label votes AND no coder holds a can't-code mark on it.
//      A single coder's vote is not consensus; a label opposed by another
//      coder's can't-code mark is an OPEN disagreement (it sits in the
//      adjudication queue) — not gold until adjudicated. Adjudicated wins
//      regardless. goldLabelMap (_shared.js) is the single assembly point,
//      so machine-vs-gold agreement, freeze, drift, reliability and DSL
//      gold rows all inherit the rule together.
//   2. EXCLUSION HYGIENE: adjudicator-excluded units contribute NO rows to
//      the human agreement statistics (n, κ, α, percent, AC1).
//   3. DEADLOCK: a unit every coder marked can't-code can never become
//      consensus gold; it must be resolvable by adjudication (exclude or
//      label) so the set can complete. The UI queue derivation
//      (calibration.js disagreementsOf) lists it.
//   4. BLIND SPRINT FEED: GET goldsets/:g/next carries only unit id/text/pos,
//      the codebook (now including worked examples) and the requesting
//      coder's own progress — plus `remaining`, the same blind fields for
//      the coder's whole remaining queue (the in-app sprint's unit source).
//      No machine output, no other coder, no adjudicated label.
//   5. RESAMPLE SALT: a redraw with identical parameters must produce a new
//      sample — the seed carries a persisted per-goldset draw counter
//      (counter 0 omits the salt, so first draws stay seed-compatible).
//   6. LABEL VALIDATION: new coder labels and adjudications validate against
//      the construct's categories (or scale bounds for continuous);
//      extraction/free types stay unvalidated; stored labels are never
//      retro-validated.
//   7. STRATIFIED MIN-1: every non-empty stratum lands ≥1 unit when n allows
//      it (π stays take/N per stratum); n below the stratum count → 400.
//   8. BOOTSTRAP CI: the human agreement report carries a percentile
//      bootstrap CI for α as humanAgreement.ci {lo, hi, method}.
//
// Harness mirrors tests/server/goldset-guards.test.js: real server on an
// ephemeral port over temp CONCORD_PROJECTS_DIR/CONCORD_CONFIG_DIR; tests run
// serially in declaration order and share state via S. No provider needed —
// the construct has no instruments, so agreement's machine pass is a no-op.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startServer } from "../../server/index.js";
import { disagreementsOf, UNCODABLE } from "../../app/js/screens/calibration.js";

// ---------------------------------------------------------------- harness

let tmpProjects;
let tmpConfig;
let srv;
let base;

before(async () => {
  tmpProjects = await mkdtemp(path.join(os.tmpdir(), "concord-goldint-"));
  tmpConfig = await mkdtemp(path.join(os.tmpdir(), "concord-goldint-cfg-"));
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
  return json.data;
}

// 60 rows; region strata 56/2/2 — south and east are the min-1 fixture; the
// indexed text keeps the response column long enough to detect as text.
function makeCsv() {
  const lines = ["respondent_id,region,response"];
  for (let i = 0; i < 60; i++) {
    const region = i < 56 ? "north" : i < 58 ? "south" : "east";
    const text =
      i % 2 === 0
        ? `the salary is too low for this work and it never improves around here (${i})`
        : `the office is comfortable and the team is genuinely kind to everyone (${i})`;
    lines.push(`r${i},${region},${text}`);
  }
  return lines.join("\n") + "\n";
}

const EXAMPLES = [
  { text: "What they pay us is insulting.", label: "yes", kind: "positive" },
  { text: "Great team, decent comp.", label: "no", kind: "negative" },
];

// ------------------------------------------------------------ shared state

const S = {
  slug: null,
  corpusId: null,
  constructId: null, // binary, categories yes/no, worked examples
  contId: null, // continuous, scale 1..5
  extId: null, // extraction — free labels
  gs1: null, // the consensus-rule fixture
  gs1Units: [],
};

const G = (rest = "") => `/api/projects/${S.slug}/goldsets${rest}`;
const goldsetArtifact = (id) => path.join(tmpProjects, S.slug, "gold", `${id}.json`);

// ---------------------------------------------------------------- the tests

test("setup: project + corpus + three constructs (categories / continuous / extraction)", async () => {
  const project = await ok("POST", "/api/projects", {
    name: "Gold Integrity",
    privacyMode: "open",
  });
  S.slug = project.slug;

  const up = await upload(`/api/projects/${S.slug}/import`, "survey.csv", makeCsv());
  const confirmed = await ok("POST", `/api/projects/${S.slug}/import/confirm`, {
    importId: up.importId,
    mapping: { textColumn: "response" },
    unitization: { scheme: "response" },
  });
  S.corpusId = confirmed.corpusId;
  assert.equal(confirmed.unitCount, 60);

  const binary = await ok("POST", `/api/projects/${S.slug}/constructs`, {
    name: "Pay complaint",
    type: "binary",
    definition: "The unit complains about compensation level or fairness.",
    criteria: {
      include: ["names compensation as a problem"],
      exclude: ["benefits-only complaints"],
    },
    examples: EXAMPLES,
    categories: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
  });
  S.constructId = binary.id;

  const cont = await ok("POST", `/api/projects/${S.slug}/constructs`, {
    name: "Complaint intensity",
    type: "continuous",
    definition: "How intense the complaint reads, 1 (mild) to 5 (furious).",
    scale: { min: 1, max: 5 },
  });
  S.contId = cont.id;

  const ext = await ok("POST", `/api/projects/${S.slug}/constructs`, {
    name: "Named grievance",
    type: "extraction",
    definition: "The exact phrase naming the grievance, verbatim.",
  });
  S.extId = ext.id;
});

// =========================================================================
// 1 + 3 — the consensus rule and the unanimous-can't-code deadlock
// =========================================================================

test("consensus gold: a single voice is not gold; label vs can't-code is an open conflict; ≥2 unanimous labels are gold", async () => {
  const gs = await ok("POST", G(), { constructId: S.constructId, corpusId: S.corpusId });
  S.gs1 = gs.id;
  const sampled = await ok("POST", G(`/${gs.id}/sample`), { design: "srs", n: 6 });
  const u = sampled.sample.map((s) => s.unitId);
  S.gs1Units = u;

  // u0 single voice · u1 unanimous ×2 · u2 split · u3 label vs can't-code ·
  // u4 both can't-code · u5 unanimous ×2
  await ok("POST", G(`/${gs.id}/label`), { coder: "ann", unitId: u[0], label: "yes" });
  await ok("POST", G(`/${gs.id}/label`), { coder: "ann", unitId: u[1], label: "yes" });
  await ok("POST", G(`/${gs.id}/label`), { coder: "ben", unitId: u[1], label: "yes" });
  await ok("POST", G(`/${gs.id}/label`), { coder: "ann", unitId: u[2], label: "yes" });
  await ok("POST", G(`/${gs.id}/label`), { coder: "ben", unitId: u[2], label: "no" });
  await ok("POST", G(`/${gs.id}/label`), { coder: "ann", unitId: u[3], label: "yes" });
  await ok("POST", G(`/${gs.id}/label`), { coder: "ben", unitId: u[3], uncodable: true });
  await ok("POST", G(`/${gs.id}/label`), { coder: "ann", unitId: u[4], uncodable: true });
  await ok("POST", G(`/${gs.id}/label`), { coder: "ben", unitId: u[4], uncodable: true });
  await ok("POST", G(`/${gs.id}/label`), { coder: "ann", unitId: u[5], label: "no" });
  await ok("POST", G(`/${gs.id}/label`), { coder: "ben", unitId: u[5], label: "no" });

  const r = await ok("GET", G(`/${gs.id}/agreement`));
  assert.equal(
    r.goldLabeled,
    2,
    "only u1 and u5 (≥2 coders unanimous, no conflicting mark) are gold",
  );
  assert.equal(r.humanAgreement.n, 3, "u1, u2, u5 are the pairable units");
  assert.equal(r.humanAgreement.uncodableUnits, 2, "u3 and u4 carry can't-code marks");
  assert.equal(r.humanAgreement.excludedFromAgreement, 3, "u0, u3, u4 lack two codable labels");
});

test("adjudication always wins — over a single voice, a split, and a label-vs-can't-code conflict; excluding the unanimous-can't-code unit completes the set", async () => {
  const u = S.gs1Units;
  await ok("POST", G(`/${S.gs1}/adjudicate`), { unitId: u[3], label: "no" });
  await ok("POST", G(`/${S.gs1}/adjudicate`), { unitId: u[0], label: "yes" });
  const r2 = await ok("POST", G(`/${S.gs1}/adjudicate`), { unitId: u[2], label: "yes" });
  assert.notEqual(
    r2.status,
    "complete",
    "the unit everyone marked can't-code still blocks completion",
  );

  const done = await ok("POST", G(`/${S.gs1}/adjudicate`), { unitId: u[4], exclude: true });
  assert.equal(
    done.status,
    "complete",
    "an adjudicator exclusion resolves the unanimous-can't-code deadlock",
  );

  const r = await ok("GET", G(`/${S.gs1}/agreement`));
  assert.equal(r.goldLabeled, 5, "3 adjudicated + 2 consensus; the excluded unit stays out");
});

test("adjudication queue (UI derivation): units everyone marked can't-code are queued; a single coder's label is not", () => {
  const goldset = {
    sample: [
      { unitId: "u1", pi: 0.1 },
      { unitId: "u2", pi: 0.1 },
      { unitId: "u3", pi: 0.1 },
    ],
    coders: [
      { coderId: "ann", labels: { u2: "yes" }, uncodable: { u1: true } },
      { coderId: "ben", labels: {}, uncodable: { u1: true } },
    ],
  };
  const queue = disagreementsOf(goldset);
  const ids = queue.map((d) => d.unitId);
  assert.ok(
    ids.includes("u1"),
    "the unanimous can't-code unit needs a human disposition — it must queue",
  );
  assert.deepEqual(queue.find((d) => d.unitId === "u1").labels, { ann: UNCODABLE, ben: UNCODABLE });
  assert.ok(!ids.includes("u2"), "a single coder's label is not a disagreement");
  assert.ok(!ids.includes("u3"), "an untouched unit is not queued");
});

// =========================================================================
// 2 + 8 — exclusion hygiene in human agreement; the bootstrap CI
// =========================================================================

test("agreement: the human report carries a bootstrap CI for α; an adjudicator exclusion removes the unit's rows from the statistics", async () => {
  const gs = await ok("POST", G(), { constructId: S.constructId, corpusId: S.corpusId });
  const sampled = await ok("POST", G(`/${gs.id}/sample`), { design: "srs", n: 12 });
  const u = sampled.sample.map((s) => s.unitId);
  for (let i = 0; i < u.length; i++) {
    const truth = i % 2 === 0 ? "yes" : "no";
    await ok("POST", G(`/${gs.id}/label`), { coder: "ann", unitId: u[i], label: truth });
    await ok("POST", G(`/${gs.id}/label`), {
      coder: "ben",
      unitId: u[i],
      label: i === 11 ? "yes" : truth,
    });
  }

  const before = await ok("GET", G(`/${gs.id}/agreement`));
  assert.equal(before.humanAgreement.n, 12);
  assert.ok(
    Math.abs(before.humanAgreement.percent - 11 / 12) < 1e-9,
    `one planted disagreement (got ${before.humanAgreement.percent})`,
  );
  const ci = before.humanAgreement.ci;
  assert.ok(ci, "humanAgreement.ci present");
  assert.equal(ci.method, "bootstrap-percentile");
  assert.ok(typeof ci.lo === "number" && typeof ci.hi === "number" && ci.lo <= ci.hi);
  assert.ok(
    ci.lo <= before.humanAgreement.alpha && before.humanAgreement.alpha <= ci.hi,
    `lo ${ci.lo} ≤ α ${before.humanAgreement.alpha} ≤ hi ${ci.hi}`,
  );

  await ok("POST", G(`/${gs.id}/adjudicate`), { unitId: u[11], exclude: true });
  const after = await ok("GET", G(`/${gs.id}/agreement`));
  assert.equal(after.humanAgreement.n, 11, "the excluded unit contributes no agreement rows");
  assert.equal(
    after.humanAgreement.percent,
    1,
    "the lone disagreement left with the excluded unit",
  );
  assert.equal(
    after.humanAgreement.excludedFromAgreement,
    0,
    "an adjudicator-excluded unit is out of the disclosure counts too",
  );
  assert.equal(after.goldLabeled, 11);
});

// =========================================================================
// 4 — the blind sprint feed (shape pinned), worked examples included
// =========================================================================

test("blind next: only unit id/text/pos, the codebook (with worked examples) and own progress — plus the blind remaining queue", async () => {
  const gs = await ok("POST", G(), { constructId: S.constructId, corpusId: S.corpusId });
  const sampled = await ok("POST", G(`/${gs.id}/sample`), { design: "srs", n: 3 });
  const u = sampled.sample.map((s) => s.unitId);
  // plant everything that must NOT leak: another coder's label and an
  // adjudicated gold label on the same unit
  await ok("POST", G(`/${gs.id}/label`), { coder: "rival", unitId: u[0], label: "yes" });
  await ok("POST", G(`/${gs.id}/adjudicate`), { unitId: u[0], label: "yes" });

  const res = await call("GET", G(`/${gs.id}/next?coder=newcoder`));
  assert.equal(res.status, 200, res.text?.slice(0, 300));
  for (const marker of [
    '"juror"',
    '"machine',
    '"adjudicated"',
    '"labels"',
    '"rationale"',
    '"confidence"',
    "rival",
  ]) {
    assert.ok(
      !res.text.includes(marker),
      `blind payload must not contain ${marker}: ${res.text.slice(0, 400)}`,
    );
  }

  const data = res.json.data;
  assert.deepEqual(
    Object.keys(data).sort(),
    ["construct", "progress", "remaining", "unit"],
    "payload shape pinned",
  );
  assert.equal(
    data.remaining.length,
    3,
    "the coder's whole remaining queue rides along for the sprint",
  );
  for (const item of data.remaining) {
    assert.deepEqual(
      Object.keys(item).sort(),
      ["id", "pos", "text"],
      "remaining units are id/text/pos only",
    );
    assert.equal(typeof item.text, "string");
  }
  assert.deepEqual(data.unit, data.remaining[0], "unit stays the first remaining entry");
  assert.deepEqual(
    data.construct.examples,
    EXAMPLES,
    "worked examples reach the human coder word for word",
  );
  assert.deepEqual([data.progress.done, data.progress.total], [0, 3]);

  // labeling shrinks the remaining queue for THAT coder only
  await ok("POST", G(`/${gs.id}/label`), { coder: "newcoder", unitId: u[0], label: "no" });
  const next = await ok("GET", G(`/${gs.id}/next?coder=newcoder`));
  assert.equal(next.remaining.length, 2);
  assert.ok(!next.remaining.some((x) => x.id === u[0]), "the labeled unit left the blind queue");
});

// =========================================================================
// 5 — resample salt: same parameters, different draw
// =========================================================================

test("resample: a forced redraw with identical parameters draws a different sample; the draw counter persists on the artifact", async () => {
  const gs = await ok("POST", G(), { constructId: S.constructId, corpusId: S.corpusId });
  const first = await ok("POST", G(`/${gs.id}/sample`), { design: "srs", n: 10 });
  const ids1 = first.sample.map((s) => s.unitId).sort();
  assert.ok(
    first.sample.every((s) => Math.abs(s.pi - 10 / 60) < 1e-12),
    "SRS π = n/N",
  );

  // commit one label so the redraw demands force — the confirm dialog's path
  await ok("POST", G(`/${gs.id}/label`), {
    coder: "ann",
    unitId: first.sample[0].unitId,
    label: "yes",
  });
  await fail("POST", G(`/${gs.id}/sample`), { design: "srs", n: 10 }, 409, "CONFIRM_REQUIRED");

  const second = await ok("POST", G(`/${gs.id}/sample`), { design: "srs", n: 10, force: true });
  const ids2 = second.sample.map((s) => s.unitId).sort();
  assert.notDeepEqual(
    ids2,
    ids1,
    "a forced redraw with unchanged parameters must not re-deal the identical sample",
  );
  assert.ok(
    second.sample.every((s) => Math.abs(s.pi - 10 / 60) < 1e-12),
    "π is untouched by the seed salt",
  );

  // a third draw (no committed work now) differs again — the counter advances
  const third = await ok("POST", G(`/${gs.id}/sample`), { design: "srs", n: 10 });
  assert.notDeepEqual(third.sample.map((s) => s.unitId).sort(), ids2);

  const artifact = JSON.parse(await readFile(goldsetArtifact(gs.id), "utf8"));
  assert.equal(artifact.sampleDraws, 3, "the per-goldset draw counter persists");
});

// =========================================================================
// 6 — label validation on adjudication AND coder submission
// =========================================================================

test("validation: category constructs refuse unknown labels (naming the valid values) on adjudicate and on coder submission; good labels pass", async () => {
  const gs = await ok("POST", G(), { constructId: S.constructId, corpusId: S.corpusId });
  const sampled = await ok("POST", G(`/${gs.id}/sample`), { design: "srs", n: 2 });
  const [ua, ub] = sampled.sample.map((s) => s.unitId);

  const aerr = await fail(
    "POST",
    G(`/${gs.id}/adjudicate`),
    { unitId: ua, label: "maybee" },
    400,
    "VALIDATION",
  );
  assert.match(aerr.message, /yes/);
  assert.match(aerr.message, /no/);
  assert.deepEqual(
    aerr.details.valid,
    ["yes", "no"],
    "the valid category values ride the error details",
  );

  const lerr = await fail(
    "POST",
    G(`/${gs.id}/label`),
    { coder: "ann", unitId: ua, label: "absolutely" },
    400,
    "VALIDATION",
  );
  assert.match(lerr.message, /yes/);
  assert.match(lerr.message, /no/);

  await ok("POST", G(`/${gs.id}/label`), { coder: "ann", unitId: ua, label: "yes" });
  await ok("POST", G(`/${gs.id}/adjudicate`), { unitId: ub, label: "no" });
  // uncodable is a disposition, not a label — it bypasses label validation
  await ok("POST", G(`/${gs.id}/label`), { coder: "ann", unitId: ub, uncodable: true });
});

test("validation: continuous constructs enforce the scale bounds; extraction stays free", async () => {
  const cgs = await ok("POST", G(), { constructId: S.contId, corpusId: S.corpusId });
  const cs = await ok("POST", G(`/${cgs.id}/sample`), { design: "srs", n: 2 });
  const [ca, cb] = cs.sample.map((s) => s.unitId);

  const cerr = await fail(
    "POST",
    G(`/${cgs.id}/label`),
    { coder: "ann", unitId: ca, label: 9 },
    400,
    "VALIDATION",
  );
  assert.match(cerr.message, /1/);
  assert.match(cerr.message, /5/);
  await ok("POST", G(`/${cgs.id}/label`), { coder: "ann", unitId: ca, label: 3 });
  await fail("POST", G(`/${cgs.id}/adjudicate`), { unitId: cb, label: 0 }, 400, "VALIDATION");
  await fail("POST", G(`/${cgs.id}/adjudicate`), { unitId: cb, label: "warm" }, 400, "VALIDATION");
  await ok("POST", G(`/${cgs.id}/adjudicate`), { unitId: cb, label: 2.5 });

  const egs = await ok("POST", G(), { constructId: S.extId, corpusId: S.corpusId });
  const es = await ok("POST", G(`/${egs.id}/sample`), { design: "srs", n: 1 });
  await ok("POST", G(`/${egs.id}/label`), {
    coder: "ann",
    unitId: es.sample[0].unitId,
    label: "any free text stays legal",
  });
});

// =========================================================================
// 7 — stratified min-1 coverage
// =========================================================================

test("stratified: every non-empty stratum lands at least one unit with π = take/N per stratum; n below the stratum count → VALIDATION", async () => {
  const gs = await ok("POST", G(), { constructId: S.constructId, corpusId: S.corpusId });
  const sampled = await ok("POST", G(`/${gs.id}/sample`), {
    design: "stratified",
    n: 10,
    strata: { by: "region" },
  });
  assert.equal(sampled.n, 10);

  const units = (
    await readFile(path.join(tmpProjects, S.slug, "corpora", S.corpusId, "units.ndjson"), "utf8")
  )
    .split(/\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const regionOf = new Map(units.map((un) => [un.id, un.meta.region]));
  const byRegion = { north: [], south: [], east: [] };
  for (const s of sampled.sample) byRegion[regionOf.get(s.unitId)].push(s);

  assert.ok(byRegion.south.length >= 1, "the 2-unit south stratum is covered");
  assert.ok(byRegion.east.length >= 1, "the 2-unit east stratum is covered");
  assert.equal(byRegion.north.length + byRegion.south.length + byRegion.east.length, 10);
  for (const s of byRegion.south) {
    assert.ok(Math.abs(s.pi - byRegion.south.length / 2) < 1e-12, `south π = take/N (got ${s.pi})`);
  }
  for (const s of byRegion.east) {
    assert.ok(Math.abs(s.pi - byRegion.east.length / 2) < 1e-12, `east π = take/N (got ${s.pi})`);
  }
  for (const s of byRegion.north) {
    assert.ok(
      Math.abs(s.pi - byRegion.north.length / 56) < 1e-12,
      `north π = take/N (got ${s.pi})`,
    );
  }

  const err = await fail(
    "POST",
    G(`/${gs.id}/sample`),
    { design: "stratified", n: 2, strata: { by: "region" } },
    400,
    "VALIDATION",
  );
  assert.match(
    err.message,
    /at least 3/,
    "the error tells the user to raise n to the stratum count",
  );
});
