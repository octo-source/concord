// PII at re-unitize — pins that POST /api/projects/:p/corpora/:c/reunitize
// RE-RUNS the source corpus's pii mode on the derived corpus instead of
// silently dropping it. Before this wiring, promoting a metadata column to
// unit text produced a derived corpus with no pii record at all — on a
// pseudonymized parent that bypassed the researcher's masking choice.
//
// Contract under test:
//   - parent mode "scan" (or absent — corpora predating the pii fields):
//     the derived units are re-scanned; {mode: "scan", counts} rides the
//     response, the derived corpus entry, and the corpus.unitized payload;
//   - parent mode "pseudonymize": the derived corpus gets its OWN vault at
//     projects/<slug>/vault/<derivedId>.json, seeded from the parent's map,
//     so parent tokens stay protected no-ops and numbering continues past
//     them; identifiers the original pass never saw (metadata masked before
//     meta coverage existed) are masked NOW; ledger appends pii.pseudonymized
//     for the derived corpus; the parent vault is never written;
//   - parent mode "off": inherited — no scan, no flags, no vault;
//   - parent pseudonymized but vault missing: VAULT_CONFLICT (400), never
//     remint tokens the derived text already carries.
//
// Harness mirrors tests/server/pii-import.test.js: the real server on an
// ephemeral port over temp CONCORD_PROJECTS_DIR / CONCORD_CONFIG_DIR; tests
// run serially in declaration order.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startServer } from "../../server/index.js";
import { projectDir, updateProject, readNdjson } from "../../server/core/store.js";
import * as ledger from "../../server/core/ledger.js";

// ---------------------------------------------------------------- harness

let tmpProjects;
let tmpConfig;
let srv;
let base;

before(async () => {
  tmpProjects = await mkdtemp(path.join(os.tmpdir(), "concord-pii-re-"));
  tmpConfig = await mkdtemp(path.join(os.tmpdir(), "concord-pii-re-cfg-"));
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

// ----------------------------------------------------------------- fixture

// All identifiers sit in the "contact" METADATA column; the unit text is
// clean lowercase prose (keeps the name heuristic quiet, makes every count
// attributable). Row m2 has an empty contact → skipped on reunitize.
const META_EMAIL = "meta.owner@example.net";
const META_PHONE = "(212) 555-0143";
const LEGACY_EMAIL = "legacy.leak@example.org";

function makeMetaPiiCsv() {
  return [
    "respondent_id,contact,response",
    `m0,${META_EMAIL},the survey portal stayed broken for the whole team this quarter`,
    `m1,${META_PHONE},my onboarding paperwork never arrived and nobody answered upstairs`,
    "m2,,the office is comfortable and the team is genuinely kind to newcomers",
  ].join("\n") + "\n";
}

const unitsFile = (slug, corpusId) => path.join(projectDir(slug), "corpora", corpusId, "units.ndjson");
const vaultFile = (slug, corpusId) => path.join(projectDir(slug), "vault", `${corpusId}.json`);
const ZERO_COUNTS = { email: 0, phone: 0, ssn: 0, url_user: 0, name: 0 };

async function importWith(slug, pii) {
  await ok("POST", "/api/projects", { name: `Project ${slug}`, slug });
  const up = await upload(`/api/projects/${slug}/import`, "meta-pii.csv", makeMetaPiiCsv());
  return ok("POST", `/api/projects/${slug}/import/confirm`, {
    importId: up.importId,
    mapping: { textColumn: "response" },
    unitization: { scheme: "response" },
    ...(pii === undefined ? {} : { pii }),
  });
}

const reunitize = (slug, corpusId, textColumn) =>
  ok("POST", `/api/projects/${slug}/corpora/${corpusId}/reunitize`, { textColumn });

// =========================================================================

test("scan parent: reunitize re-scans the derived corpus — counts in response, entry and ledger", async () => {
  const slug = "re-scan";
  const confirmed = await importWith(slug, undefined); // default scan
  const re = await reunitize(slug, confirmed.corpusId, "contact");

  assert.equal(re.unitCount, 2, "empty-contact row skipped");
  assert.equal(re.skipped, 1);
  assert.equal(re.pii?.mode, "scan", `response pii: ${JSON.stringify(re.pii)}`);
  // the promoted column's identifiers are now UNIT TEXT — the re-scan sees them
  assert.deepEqual(re.pii.counts, { ...ZERO_COUNTS, email: 1, phone: 1 });

  // derived units flagged; raw text kept (scan never rewrites)
  const units = await readNdjson(unitsFile(slug, re.corpusId));
  const emailUnit = units.find((u) => u.text === META_EMAIL);
  assert.ok(emailUnit, "raw email is the derived unit text under scan");
  assert.ok(emailUnit.flags?.pii?.includes("email"), `flags: ${JSON.stringify(emailUnit.flags)}`);

  // derived corpus entry records the treatment, like an imported corpus
  const p = await ok("GET", `/api/projects/${slug}`);
  const derived = p.corpora.find((c) => c.id === re.corpusId);
  assert.deepEqual(derived.pii, { mode: "scan", counts: { ...ZERO_COUNTS, email: 1, phone: 1 } });

  // ledger: the derived corpus.unitized payload carries the pii summary
  const ev = await ledger.query(projectDir(slug), { type: "corpus.unitized" });
  assert.equal(ev.at(-1).refs.corpusId, re.corpusId);
  assert.deepEqual(ev.at(-1).payload.pii, { mode: "scan", counts: { ...ZERO_COUNTS, email: 1, phone: 1 } });

  // scan never writes a vault
  await assert.rejects(access(vaultFile(slug, re.corpusId)));
});

test("pseudonymize parent: derived corpus keeps tokens, gets its own seeded vault, parent vault untouched", async () => {
  const slug = "re-mask";
  const confirmed = await importWith(slug, "pseudonymize");
  const parentVaultBefore = await readFile(vaultFile(slug, confirmed.corpusId), "utf8");

  const re = await reunitize(slug, confirmed.corpusId, "contact");
  assert.equal(re.unitCount, 2);
  assert.equal(re.pii?.mode, "pseudonymize");
  // everything the promoted column carried was already masked at import —
  // counts report what THIS pass replaced, so they are zero here
  assert.deepEqual(re.pii.counts, ZERO_COUNTS);

  // derived unit text is the token, never the identifier
  const raw = await readFile(unitsFile(slug, re.corpusId), "utf8");
  assert.ok(!raw.includes(META_EMAIL), "raw email never reaches the derived corpus");
  assert.ok(!raw.includes(META_PHONE), "raw phone never reaches the derived corpus");
  const units = await readNdjson(unitsFile(slug, re.corpusId));
  const tokenUnit = units.find((u) => /^\[EMAIL_\d+\]$/.test(u.text));
  assert.ok(tokenUnit, `derived text carries the parent's token (got ${JSON.stringify(units.map((u) => u.text))})`);

  // the derived corpus has its OWN vault, seeded from the parent's map, so
  // its tokens re-identify without reaching back to the parent corpus
  const derivedVault = JSON.parse(await readFile(vaultFile(slug, re.corpusId), "utf8"));
  assert.equal(derivedVault.tokens[tokenUnit.text], META_EMAIL, "seeded vault resolves the promoted token");
  assert.ok(Object.values(derivedVault.tokens).includes(META_PHONE));

  // the parent vault was read, never written
  const parentVaultAfter = await readFile(vaultFile(slug, confirmed.corpusId), "utf8");
  assert.equal(parentVaultAfter, parentVaultBefore, "parent vault byte-identical after reunitize");

  // entry + reserved ledger event for the derived corpus
  const p = await ok("GET", `/api/projects/${slug}`);
  const derived = p.corpora.find((c) => c.id === re.corpusId);
  assert.equal(derived.pii?.mode, "pseudonymize");
  const evs = await ledger.query(projectDir(slug), { type: "pii.pseudonymized" });
  assert.equal(evs.length, 2, "one for import, one for reunitize");
  assert.deepEqual(evs.at(-1).refs, { corpusId: re.corpusId });
  assert.equal(evs.at(-1).payload.tokenCount, 2, "seeded tokens counted in the derived vault");
});

test("pseudonymize parent with raw legacy metadata: the bypass is closed — masked at reunitize", async () => {
  const slug = "re-legacy";
  const confirmed = await importWith(slug, "pseudonymize");
  const parentVaultBefore = await readFile(vaultFile(slug, confirmed.corpusId), "utf8");

  // Simulate a corpus pseudonymized BEFORE metadata coverage existed: plant a
  // raw identifier in a metadata column the import-time pass never saw.
  const units = await readNdjson(unitsFile(slug, confirmed.corpusId));
  units[0].meta.legacy_contact = LEGACY_EMAIL;
  await writeFile(unitsFile(slug, confirmed.corpusId), units.map((u) => JSON.stringify(u)).join("\n") + "\n", "utf8");

  const re = await reunitize(slug, confirmed.corpusId, "legacy_contact");
  assert.equal(re.unitCount, 1, "only the planted row has the column");
  assert.equal(re.skipped, 2);
  assert.equal(re.pii?.mode, "pseudonymize");
  assert.deepEqual(re.pii.counts, { ...ZERO_COUNTS, email: 1 }, "the legacy identifier was newly masked by THIS pass");

  // the derived text is a fresh token continuing the parent's numbering
  const derived = await readNdjson(unitsFile(slug, re.corpusId));
  assert.match(derived[0].text, /^\[EMAIL_\d+\]$/, `derived text masked (got ${JSON.stringify(derived[0].text)})`);
  assert.ok(!JSON.stringify(derived).includes(LEGACY_EMAIL), "raw legacy email never persists in the derived corpus");
  assert.equal(derived[0].meta.contact, "[EMAIL_1]", "parent-vault token in remaining metadata stays a protected no-op");

  // new mapping accumulated into the DERIVED vault only
  const derivedVault = JSON.parse(await readFile(vaultFile(slug, re.corpusId), "utf8"));
  assert.equal(derivedVault.tokens[derived[0].text], LEGACY_EMAIL);
  const parentVaultAfter = await readFile(vaultFile(slug, confirmed.corpusId), "utf8");
  assert.equal(parentVaultAfter, parentVaultBefore, "parent vault still untouched");
  assert.ok(!parentVaultAfter.includes(LEGACY_EMAIL), "legacy mapping lives only in the derived vault");
});

test("off parent: reunitize inherits off — raw text honored, no flags, no vault", async () => {
  const slug = "re-off";
  const confirmed = await importWith(slug, "off");
  const re = await reunitize(slug, confirmed.corpusId, "contact");

  assert.deepEqual(re.pii, { mode: "off" });
  const units = await readNdjson(unitsFile(slug, re.corpusId));
  assert.ok(units.some((u) => u.text === META_EMAIL), "off leaves the promoted text untouched");
  assert.ok(units.every((u) => u.flags?.pii === undefined), "no pii flags in off mode");
  await assert.rejects(access(path.join(projectDir(slug), "vault")), "off creates no vault dir");

  const p = await ok("GET", `/api/projects/${slug}`);
  assert.deepEqual(p.corpora.find((c) => c.id === re.corpusId).pii, { mode: "off" });
});

test("parent without a pii record (predates the wiring): derived corpus defaults to scan", async () => {
  const slug = "re-legacy-entry";
  const confirmed = await importWith(slug, "off");
  // corpora imported before the pii fields existed carry no record at all
  await updateProject(slug, (p) => {
    delete p.corpora.find((c) => c.id === confirmed.corpusId).pii;
  });

  const re = await reunitize(slug, confirmed.corpusId, "contact");
  assert.equal(re.pii?.mode, "scan", "absent record falls back to the import default");
  assert.deepEqual(re.pii.counts, { ...ZERO_COUNTS, email: 1, phone: 1 });
  const units = await readNdjson(unitsFile(slug, re.corpusId));
  assert.ok(units.find((u) => u.text === META_EMAIL)?.flags?.pii?.includes("email"));
});

test("pseudonymize parent whose vault is missing: VAULT_CONFLICT, never remint over existing tokens", async () => {
  const slug = "re-no-vault";
  const confirmed = await importWith(slug, "pseudonymize");
  await rm(vaultFile(slug, confirmed.corpusId), { force: true });

  // the derived text would carry [EMAIL_1]/[PHONE_1] that a fresh vault
  // cannot resolve — reminting would alias them to different originals
  await fail("POST", `/api/projects/${slug}/corpora/${confirmed.corpusId}/reunitize`,
    { textColumn: "contact" }, 400, "VAULT_CONFLICT");
});
