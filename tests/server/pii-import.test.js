// PII at import-confirm — pins the wiring of server/ingest/pii.js into
// POST /api/projects/:p/import/confirm, and the privacy property that the
// re-identification vault NEVER enters the replication archive.
//
// Contract under test:
//   confirm body gains pii: "off" | "scan" | "pseudonymize" (DEFAULT "scan");
//   - scan: units keep raw text on disk, unit.flags.pii set, counts surface in
//     the response, the corpus record and the corpus.imported ledger event;
//   - pseudonymize: the MASKED units are what persists; the reversible map is
//     written to projects/<slug>/vault/<corpusId>.json; ledger appends the
//     taxonomy's reserved pii.pseudonymized event;
//   - off: no scan, no flags, no vault — only pii.mode "off" recorded;
//   - unknown pii value → VALIDATION;
//   - the replication zip and its MANIFEST list no member under vault/.
//
// Harness mirrors tests/unit/routes.test.js: the real server on an ephemeral
// port over temp CONCORD_PROJECTS_DIR / CONCORD_CONFIG_DIR; tests run serially
// in declaration order and share state via S.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";

import { startServer } from "../../server/index.js";
import { projectDir, updateProject, readNdjson } from "../../server/core/store.js";
import * as ledger from "../../server/core/ledger.js";

// ---------------------------------------------------------------- harness

let tmpProjects;
let tmpConfig;
let srv;
let base;

before(async () => {
  tmpProjects = await mkdtemp(path.join(os.tmpdir(), "concord-pii-"));
  tmpConfig = await mkdtemp(path.join(os.tmpdir(), "concord-pii-cfg-"));
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
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
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

// ----------------------------------------------------------------- fixture

const RAW_EMAIL = "jane.doe@example.com";
const RAW_EMAIL_2 = "backup.contact@example.org";
const RAW_PHONE = "555-867-5309";
const RAW_PHONE_2 = "(212) 555-0143";

// 6 rows, 2 emails + 2 phone numbers; all lowercase prose so the capitalized-
// bigram name heuristic stays quiet and the email/phone counts are exact.
function makePiiCsv() {
  return (
    [
      "respondent_id,dept,response",
      `r0,ops,you can reach me directly at ${RAW_EMAIL} if the survey portal stays broken for the whole team`,
      `r1,sales,my manager said to call ${RAW_PHONE} before friday because the onboarding paperwork never arrived`,
      "r2,ops,the office is comfortable and the team is genuinely kind to everyone who joins the rotation",
      `r3,sales,second inbox ${RAW_EMAIL_2} sits unread and the phone tree at ${RAW_PHONE_2} rings forever`,
      "r4,ops,the deadline pressure is constant and nobody upstairs wants to hear about it this quarter",
      "r5,sales,pay is fine but the commute eats two hours every day and the parking situation is hopeless",
    ].join("\n") + "\n"
  );
}

const unitsFile = (slug, corpusId) =>
  path.join(projectDir(slug), "corpora", corpusId, "units.ndjson");
const vaultFile = (slug, corpusId) => path.join(projectDir(slug), "vault", `${corpusId}.json`);

// create a project, upload the fixture, confirm with the given pii mode
// (undefined = omit the field, exercising the default)
async function importWith(slug, pii) {
  await ok("POST", "/api/projects", { name: `Project ${slug}`, slug });
  const up = await upload(`/api/projects/${slug}/import`, "pii-fixture.csv", makePiiCsv());
  return ok("POST", `/api/projects/${slug}/import/confirm`, {
    importId: up.importId,
    mapping: { textColumn: "response" },
    unitization: { scheme: "response" },
    ...(pii === undefined ? {} : { pii }),
  });
}

const S = { maskSlug: null, maskCorpus: null };

// =========================================================================

test("confirm without pii defaults to scan: counts surface, raw text persists, units flagged", async () => {
  const slug = "pii-scan";
  const confirmed = await importWith(slug, undefined);
  assert.equal(confirmed.unitCount, 6);
  assert.ok(confirmed.junkQueue?.counts, "junk queue unchanged by the pii step");

  // response carries pii {mode, counts}
  assert.equal(confirmed.pii?.mode, "scan", `response pii: ${JSON.stringify(confirmed.pii)}`);
  assert.ok(confirmed.pii.counts.email >= 1, "at least one email counted");
  assert.equal(confirmed.pii.counts.email, 2);
  assert.equal(confirmed.pii.counts.phone, 2);

  // units on disk retain ORIGINAL text, flagged units carry flags.pii
  const raw = await readFile(unitsFile(slug, confirmed.corpusId), "utf8");
  assert.ok(raw.includes(RAW_EMAIL), "scan leaves original text on disk");
  assert.ok(raw.includes(RAW_PHONE), "scan leaves phone numbers on disk");
  const units = await readNdjson(unitsFile(slug, confirmed.corpusId));
  const emailUnit = units.find((u) => u.text.includes(RAW_EMAIL));
  assert.ok(
    emailUnit?.flags?.pii?.includes("email"),
    `email unit flagged (got ${JSON.stringify(emailUnit?.flags)})`,
  );
  const phoneUnit = units.find((u) => u.text.includes(RAW_PHONE));
  assert.ok(phoneUnit?.flags?.pii?.includes("phone"), "phone unit flagged");
  const cleanUnit = units.find((u) => u.text.includes("comfortable"));
  assert.equal(cleanUnit.flags?.pii, undefined, "clean units carry no pii flag");

  // corpus record persists {mode, counts}
  const p = await ok("GET", `/api/projects/${slug}`);
  const corpus = p.corpora.find((c) => c.id === confirmed.corpusId);
  assert.equal(corpus.pii?.mode, "scan");
  assert.deepEqual(corpus.pii.counts, confirmed.pii.counts);

  // ledger: corpus.imported meta carries the same pii summary
  const imported = await ledger.query(projectDir(slug), { type: "corpus.imported" });
  assert.equal(imported.length, 1);
  assert.deepEqual(imported[0].payload.pii, { mode: "scan", counts: confirmed.pii.counts });

  // scanning never writes a vault
  await assert.rejects(access(vaultFile(slug, confirmed.corpusId)), "no vault for scan mode");
});

test("pseudonymize: masked units persist, vault maps token→original at the pinned path", async () => {
  const slug = "pii-mask";
  const confirmed = await importWith(slug, "pseudonymize");
  assert.equal(confirmed.pii?.mode, "pseudonymize");
  assert.equal(confirmed.pii.counts.email, 2);
  assert.equal(confirmed.pii.counts.phone, 2);

  // the persisted units contain NO raw identifier, only tokens
  const raw = await readFile(unitsFile(slug, confirmed.corpusId), "utf8");
  assert.ok(!raw.includes(RAW_EMAIL), "raw email never reaches disk");
  assert.ok(!raw.includes(RAW_EMAIL_2), "second raw email never reaches disk");
  assert.ok(!raw.includes(RAW_PHONE), "raw phone never reaches disk");
  assert.ok(raw.includes("[EMAIL_"), "masked tokens persisted in place of identifiers");
  const units = await readNdjson(unitsFile(slug, confirmed.corpusId));
  const maskedUnit = units.find((u) => u.text.includes("[EMAIL_"));
  assert.ok(maskedUnit?.flags?.pii?.includes("email"), "masked unit still flagged");

  // vault at projects/<slug>/vault/<corpusId>.json maps placeholder → original
  const vault = JSON.parse(await readFile(vaultFile(slug, confirmed.corpusId), "utf8"));
  const entry = Object.entries(vault.tokens).find(([, original]) => original === RAW_EMAIL);
  assert.ok(entry, `vault maps a token back to ${RAW_EMAIL}`);
  assert.match(entry[0], /^\[EMAIL_\d+\]$/);
  assert.ok(
    units.some((u) => u.text.includes(entry[0])),
    "persisted text carries exactly the vault's token",
  );

  // corpus record carries pii.mode + counts
  const p = await ok("GET", `/api/projects/${slug}`);
  const corpus = p.corpora.find((c) => c.id === confirmed.corpusId);
  assert.equal(corpus.pii?.mode, "pseudonymize");
  assert.deepEqual(corpus.pii.counts, confirmed.pii.counts);

  // ledger: the taxonomy's reserved pii.pseudonymized event carries the counts
  const evs = await ledger.query(projectDir(slug), { type: "pii.pseudonymized" });
  assert.equal(evs.length, 1, "one pii.pseudonymized event");
  assert.deepEqual(evs[0].refs, { corpusId: confirmed.corpusId });
  assert.deepEqual(evs[0].payload.counts, confirmed.pii.counts);

  S.maskSlug = slug;
  S.maskCorpus = confirmed.corpusId;
});

test("pii off: no flags, no vault, response and corpus record say off", async () => {
  const slug = "pii-off";
  const confirmed = await importWith(slug, "off");
  assert.equal(confirmed.pii?.mode, "off");
  assert.equal(confirmed.pii.counts, undefined, "off mode reports no counts");

  const raw = await readFile(unitsFile(slug, confirmed.corpusId), "utf8");
  assert.ok(raw.includes(RAW_EMAIL), "off leaves text untouched");
  const units = await readNdjson(unitsFile(slug, confirmed.corpusId));
  assert.ok(
    units.every((u) => u.flags?.pii === undefined),
    "no unit carries a pii flag in off mode",
  );
  await assert.rejects(
    access(path.join(projectDir(slug), "vault")),
    "off mode creates no vault dir",
  );

  const p = await ok("GET", `/api/projects/${slug}`);
  const corpus = p.corpora.find((c) => c.id === confirmed.corpusId);
  assert.deepEqual(corpus.pii, { mode: "off" });
});

test("unknown pii value → VALIDATION", async () => {
  const slug = "pii-bad";
  await ok("POST", "/api/projects", { name: `Project ${slug}`, slug });
  const up = await upload(`/api/projects/${slug}/import`, "pii-fixture.csv", makePiiCsv());
  await fail(
    "POST",
    `/api/projects/${slug}/import/confirm`,
    {
      importId: up.importId,
      mapping: { textColumn: "response" },
      unitization: { scheme: "response" },
      pii: "mask",
    },
    400,
    "VALIDATION",
  );
});

test("replication archive lists no vault/ member — the re-identification key stays local", async () => {
  const slug = S.maskSlug;
  assert.ok(slug, "pseudonymize test ran first");
  await access(vaultFile(slug, S.maskCorpus)); // precondition: the vault EXISTS on disk

  // a minimal analysis so the export route has something to bundle
  // (loadAnalysis falls back to project.analyses entries carrying a spec)
  await updateProject(slug, (p) => {
    p.analyses = p.analyses ?? [];
    p.analyses.push({
      id: "an_pin",
      spec: { corpusId: S.maskCorpus },
      level: "exploratory",
      results: {},
    });
  });

  const res = await fetch(`${base}/api/projects/${slug}/exports/replication?analyses=an_pin`);
  assert.equal(res.status, 200, `replication export → ${res.status}`);
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  const names = Object.keys(files);
  assert.ok(names.includes(`units/${S.maskCorpus}.csv`), "the corpus itself IS in the archive");
  for (const n of names) {
    assert.ok(!/(^|\/)vault(\/|$)/i.test(n), `archive member ${n} must not live under vault/`);
  }
  const manifest = JSON.parse(strFromU8(files["MANIFEST.json"]));
  for (const member of Object.keys(manifest.files)) {
    assert.ok(!/(^|\/)vault(\/|$)/i.test(member), `MANIFEST lists no vault member (got ${member})`);
  }
});

// =========================================================================
// Metadata columns — identifiers that ride OUTSIDE unit text. The fixture's
// unit text is clean; every identifier sits in the "contact" column, so any
// nonzero count below can only come from metadata. Gap being pinned: meta
// values reach the replication units CSV (and Director prompts), so scan
// must count them and pseudonymize must mask them with the same vault and
// the same [KIND_n] tokens as unit text.

const META_EMAIL = "meta.owner@example.net";
const META_PHONE = "(212) 555-0143";

function makeMetaPiiCsv() {
  return (
    [
      "respondent_id,contact,response",
      `m0,${META_EMAIL},the survey portal stayed broken for the whole team this quarter`,
      `m1,${META_PHONE},my onboarding paperwork never arrived and nobody answered upstairs`,
      "m2,,the office is comfortable and the team is genuinely kind to newcomers",
    ].join("\n") + "\n"
  );
}

async function importMetaWith(slug, pii) {
  await ok("POST", "/api/projects", { name: `Project ${slug}`, slug });
  const up = await upload(`/api/projects/${slug}/import`, "meta-pii.csv", makeMetaPiiCsv());
  return ok("POST", `/api/projects/${slug}/import/confirm`, {
    importId: up.importId,
    mapping: { textColumn: "response" },
    unitization: { scheme: "response" },
    ...(pii === undefined ? {} : { pii }),
  });
}

test("scan counts identifiers riding metadata columns", async () => {
  const slug = "pii-meta-scan";
  const confirmed = await importMetaWith(slug, undefined); // default scan
  assert.equal(confirmed.pii?.mode, "scan");
  assert.equal(
    confirmed.pii.counts.email,
    1,
    `meta email counted: ${JSON.stringify(confirmed.pii.counts)}`,
  );
  assert.equal(confirmed.pii.counts.phone, 1);

  const units = await readNdjson(unitsFile(slug, confirmed.corpusId));
  const emailUnit = units.find((u) => u.meta?.contact === META_EMAIL);
  assert.ok(emailUnit, "scan leaves the metadata value in place");
  assert.ok(
    emailUnit.flags?.pii?.includes("email"),
    `unit flagged for its meta email (got ${JSON.stringify(emailUnit.flags)})`,
  );
});

test("pseudonymize masks metadata column values — tokens persist, vault maps them back", async () => {
  const slug = "pii-meta-mask";
  const confirmed = await importMetaWith(slug, "pseudonymize");
  assert.equal(confirmed.pii?.mode, "pseudonymize");
  assert.equal(confirmed.pii.counts.email, 1);
  assert.equal(confirmed.pii.counts.phone, 1);

  const raw = await readFile(unitsFile(slug, confirmed.corpusId), "utf8");
  assert.ok(!raw.includes(META_EMAIL), "raw metadata email never reaches disk");
  assert.ok(!raw.includes(META_PHONE), "raw metadata phone never reaches disk");
  const units = await readNdjson(unitsFile(slug, confirmed.corpusId));
  const masked = units.find((u) => /^\[EMAIL_\d+\]$/.test(u.meta?.contact ?? ""));
  assert.ok(
    masked,
    `a unit's contact column carries a token (got ${JSON.stringify(units.map((u) => u.meta?.contact))})`,
  );
  assert.ok(masked.flags?.pii?.includes("email"));

  const vault = JSON.parse(await readFile(vaultFile(slug, confirmed.corpusId), "utf8"));
  assert.equal(
    vault.tokens[masked.meta.contact],
    META_EMAIL,
    "vault maps the meta token back to the original",
  );

  S.metaMaskSlug = slug;
  S.metaMaskCorpus = confirmed.corpusId;
});

test("replication units CSV exports masked metadata — tokens, never raw identifiers", async () => {
  const slug = S.metaMaskSlug;
  assert.ok(slug, "meta pseudonymize test ran first");
  await updateProject(slug, (p) => {
    p.analyses = p.analyses ?? [];
    p.analyses.push({
      id: "an_meta",
      spec: { corpusId: S.metaMaskCorpus },
      level: "exploratory",
      results: {},
    });
  });
  const res = await fetch(`${base}/api/projects/${slug}/exports/replication?analyses=an_meta`);
  assert.equal(res.status, 200, `replication export → ${res.status}`);
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  const csv = strFromU8(files[`units/${S.metaMaskCorpus}.csv`]);
  assert.ok(
    csv.includes("meta_contact"),
    `units CSV still carries the contact column: ${csv.split("\n")[0]}`,
  );
  assert.ok(!csv.includes(META_EMAIL), "raw email must not leak through the units CSV");
  assert.ok(!csv.includes(META_PHONE), "raw phone must not leak through the units CSV");
  assert.match(csv, /\[EMAIL_\d+\]/, "the masked token rides in the export instead");
});
