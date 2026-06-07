// Column roles at import-confirm — pins that the import sheet's role edits
// REACH the server instead of dying in local state.
//
// Contract under test:
//   confirm body mapping gains columns: [{name, role}] (the sheet's role map);
//   - role "ignore": the column is dropped from unit.meta AT UNITIZE — before
//     the pii step, so ignored values are never scanned, never masked, never
//     reach Director prompts or the replication units CSV (unit.meta is the
//     only carrier for all three);
//   - the corpus record persists the role map under columnRoles [{name,
//     role}] for provenance — NOT under corpus.columns, which is already the
//     GET /corpora/:c/columns cache;
//   - reunitize of a derived corpus keeps honoring the drop: derived meta is
//     built from the source units' meta, where the column no longer exists;
//   - marking the unit-text column itself "ignore" never deletes the text —
//     the explicit textColumn choice wins;
//   - confirm response gains skipped: rows whose text-column cell was empty
//     (unitize silently drops them; reunitize already reported its own).
//
// Harness mirrors tests/server/pii-import.test.js: the real server on an
// ephemeral port over temp CONCORD_PROJECTS_DIR / CONCORD_CONFIG_DIR; tests
// run serially in declaration order.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startServer } from "../../server/index.js";
import { projectDir, readNdjson } from "../../server/core/store.js";

// ---------------------------------------------------------------- harness

let tmpProjects;
let tmpConfig;
let srv;
let base;

before(async () => {
  tmpProjects = await mkdtemp(path.join(os.tmpdir(), "concord-roles-"));
  tmpConfig = await mkdtemp(path.join(os.tmpdir(), "concord-roles-cfg-"));
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
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
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
  assert.equal(res.status, 200, `upload ${p} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  assert.equal(json.ok, true);
  return json.data;
}

const unitsFile = (slug, corpusId) => path.join(projectDir(slug), "corpora", corpusId, "units.ndjson");

// ----------------------------------------------------------------- fixtures

// internal_code is the column the researcher marks "ignore"; lowercase prose
// keeps the name heuristic quiet so pii counts stay attributable.
function makeRolesCsv() {
  return [
    "respondent_id,dept,internal_code,response",
    "r0,ops,secret-7,the survey portal stayed broken for the whole team this quarter",
    "r1,sales,secret-8,my onboarding paperwork never arrived and nobody answered upstairs",
    "r2,ops,secret-9,the office is comfortable and the team is genuinely kind to newcomers",
  ].join("\n") + "\n";
}

const IGNORED_EMAIL = "owner.contact@example.net";

// every identifier sits in the to-be-ignored column; unit text is clean
function makeIgnoredPiiCsv() {
  return [
    "respondent_id,contact,response",
    `m0,${IGNORED_EMAIL},the survey portal stayed broken for the whole team this quarter`,
    "m1,,my onboarding paperwork never arrived and nobody answered upstairs",
  ].join("\n") + "\n";
}

// two empty response cells → two silently dropped rows the response must own
function makeGappyCsv() {
  return [
    "respondent_id,dept,response",
    "s0,ops,the portal stayed broken for the whole team this quarter",
    "s1,sales,",
    "s2,ops,the team is genuinely kind to newcomers and the office is calm",
    "s3,sales,",
  ].join("\n") + "\n";
}

const ROLES = [
  { name: "respondent_id", role: "id" },
  { name: "dept", role: "categorical" },
  { name: "internal_code", role: "ignore" },
  { name: "response", role: "text" },
];

async function importRoles(slug, { csv, filename, mapping, pii }) {
  await ok("POST", "/api/projects", { name: `Project ${slug}`, slug });
  const up = await upload(`/api/projects/${slug}/import`, filename, csv);
  return ok("POST", `/api/projects/${slug}/import/confirm`, {
    importId: up.importId,
    mapping,
    unitization: { scheme: "response" },
    ...(pii === undefined ? {} : { pii }),
  });
}

const S = {};

// =========================================================================

test("ignore role drops the column from unit.meta; the role map persists on the corpus record", async () => {
  const slug = "roles-ignore";
  const confirmed = await importRoles(slug, {
    csv: makeRolesCsv(),
    filename: "roles.csv",
    mapping: { textColumn: "response", columns: ROLES },
  });
  assert.equal(confirmed.unitCount, 3);
  assert.equal(confirmed.skipped, 0, "no empty text cells → skipped 0 in the response");

  // units on disk: ignored column absent, the others ride along
  const units = await readNdjson(unitsFile(slug, confirmed.corpusId));
  for (const u of units) {
    assert.ok(!("internal_code" in (u.meta ?? {})), `ignored column must not reach unit.meta (got ${JSON.stringify(u.meta)})`);
    assert.ok("dept" in u.meta, "non-ignored columns still ride as metadata");
    assert.ok("respondent_id" in u.meta);
  }

  // corpus record: role map persisted for provenance, metaColumns excludes the drop
  const p = await ok("GET", `/api/projects/${slug}`);
  const corpus = p.corpora.find((c) => c.id === confirmed.corpusId);
  assert.deepEqual(corpus.columnRoles, ROLES, "the confirmed role map persists on the corpus record");
  assert.equal(corpus.metaColumns, 2, "respondent_id + dept; internal_code dropped");

  // the role map must NOT squat on corpus.columns — that key is the
  // GET /corpora/:c/columns cache; the route must keep working
  const cols = await ok("GET", `/api/projects/${slug}/corpora/${confirmed.corpusId}/columns`);
  const names = (cols.columns ?? []).map((c) => c.name);
  assert.ok(names.includes("dept"), `columns route still lists metadata (got ${JSON.stringify(names)})`);
  assert.ok(!names.includes("internal_code"), "ignored column is not a variable anywhere downstream");

  S.slug = slug;
  S.corpusId = confirmed.corpusId;
});

test("reunitize keeps honoring the drop — derived meta is built from source units that no longer carry the column", async () => {
  const re = await ok("POST", `/api/projects/${S.slug}/corpora/${S.corpusId}/reunitize`, { textColumn: "dept" });
  const units = await readNdjson(unitsFile(S.slug, re.corpusId));
  assert.ok(units.length > 0);
  for (const u of units) {
    assert.ok(!("internal_code" in (u.meta ?? {})), `ignored column must not resurface on reunitize (got ${JSON.stringify(u.meta)})`);
    assert.ok("response" in u.meta, "the old text is preserved under its original column name");
  }
  S.derivedId = re.corpusId;
});

test("reunitize copies columnRoles to the derived corpus, adjusted for the promotion", async () => {
  const p = await ok("GET", `/api/projects/${S.slug}`);
  const derived = p.corpora.find((c) => c.id === S.derivedId);
  assert.ok(Array.isArray(derived.columnRoles), `the derived corpus carries the role map (got ${JSON.stringify(derived.columnRoles)})`);
  const roleOf = (name) => derived.columnRoles.find((c) => c.name === name)?.role;
  assert.equal(roleOf("dept"), "text", "the promoted column's entry becomes role text");
  // the demoted old text column takes the detector's call over the derived
  // units' meta — long prose, so mapping.detect reads it as text
  assert.equal(roleOf("response"), "text", "the old text column gets the detector's role");
  assert.equal(roleOf("respondent_id"), "id", "untouched roles copy through");
  assert.equal(roleOf("internal_code"), "ignore", "ignore provenance survives (the column stays physically absent)");
  assert.equal(derived.columnRoles.length, 4, "no invented entries");
});

test("reunitize of a source without a recorded role map fabricates nothing", async () => {
  const slug = "roles-none-derived";
  const confirmed = await importRoles(slug, {
    csv: makeRolesCsv(),
    filename: "no-roles.csv",
    mapping: { textColumn: "response" }, // no columns sent → no columnRoles on the source
  });
  const re = await ok("POST", `/api/projects/${slug}/corpora/${confirmed.corpusId}/reunitize`, { textColumn: "dept" });
  const p = await ok("GET", `/api/projects/${slug}`);
  const derived = p.corpora.find((c) => c.id === re.corpusId);
  assert.equal(derived.columnRoles, undefined, "no role map invented on the derived corpus");
});

test("ignore-drop happens BEFORE the pii step: identifiers in an ignored column are never scanned", async () => {
  const slug = "roles-pii";
  const confirmed = await importRoles(slug, {
    csv: makeIgnoredPiiCsv(),
    filename: "roles-pii.csv",
    mapping: {
      textColumn: "response",
      columns: [
        { name: "respondent_id", role: "id" },
        { name: "contact", role: "ignore" },
        { name: "response", role: "text" },
      ],
    },
    // default scan
  });
  assert.equal(confirmed.pii?.mode, "scan");
  assert.equal(confirmed.pii.counts.email, 0, `the ignored column's email is absent at scan time (got ${JSON.stringify(confirmed.pii.counts)})`);

  const units = await readNdjson(unitsFile(slug, confirmed.corpusId));
  assert.ok(units.every((u) => !("contact" in (u.meta ?? {}))), "ignored identifier column never persists");
  assert.ok(!JSON.stringify(units).includes(IGNORED_EMAIL), "the identifier itself is simply absent");
});

test("marking the unit-text column ignore does not delete the text — the explicit choice wins", async () => {
  const slug = "roles-text-ignore";
  const confirmed = await importRoles(slug, {
    csv: makeRolesCsv(),
    filename: "roles-text.csv",
    mapping: {
      textColumn: "response",
      columns: [
        { name: "respondent_id", role: "id" },
        { name: "dept", role: "categorical" },
        { name: "internal_code", role: "ignore" },
        { name: "response", role: "ignore" }, // contradicts the textColumn choice
      ],
    },
  });
  assert.equal(confirmed.unitCount, 3, "units still import from the chosen text column");
  const units = await readNdjson(unitsFile(slug, confirmed.corpusId));
  assert.ok(units.every((u) => (u.text ?? "").length > 0), "unit text intact");
});

test("confirm without mapping.columns behaves as before — every column rides as metadata, no role map recorded", async () => {
  const slug = "roles-absent";
  const confirmed = await importRoles(slug, {
    csv: makeRolesCsv(),
    filename: "roles-absent.csv",
    mapping: { textColumn: "response" },
  });
  const units = await readNdjson(unitsFile(slug, confirmed.corpusId));
  assert.ok(units.every((u) => "internal_code" in u.meta), "no roles sent → nothing dropped");
  const p = await ok("GET", `/api/projects/${slug}`);
  const corpus = p.corpora.find((c) => c.id === confirmed.corpusId);
  assert.equal(corpus.columnRoles, undefined, "no role map invented");
});

test("confirm response owns silently dropped empty-text rows: skipped = empty cells in the text column", async () => {
  const slug = "roles-skipped";
  const confirmed = await importRoles(slug, {
    csv: makeGappyCsv(),
    filename: "gappy.csv",
    mapping: { textColumn: "response" },
  });
  assert.equal(confirmed.unitCount, 2);
  assert.equal(confirmed.skipped, 2, `two empty response cells → skipped: 2 (got ${JSON.stringify(confirmed.skipped)})`);
});
