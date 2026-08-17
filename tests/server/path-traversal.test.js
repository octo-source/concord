// Security regression: a URL/body id that decodes to a filesystem traversal
// must never escape the project bundle. Before the safeId guard, GET
// /api/projects/<p>/analyses/..%2f..%2f..%2fconfig%2fkeys returned the
// contents of config/keys.json (the provider API keys). Every id that becomes
// a path segment now passes through _shared.safeId at the builder seam or the
// route. These tests plant a real secret OUTSIDE the projects dir and prove no
// route will read it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer } from "../../server/index.js";
import { corpusUnitsFile, goldsetFile, runOutputsFile } from "../../server/routes/_shared.js";

let tmpRoot, tmpProjects, tmpConfig, srv, base, slug;
const SECRET = "sk-or-v1-PLANTED-SECRET-DO-NOT-LEAK";

before(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "concord-trav-"));
  tmpProjects = path.join(tmpRoot, "projects");
  tmpConfig = path.join(tmpRoot, "config");
  await mkdir(tmpProjects, { recursive: true });
  await mkdir(tmpConfig, { recursive: true });
  // the secret a traversal would target — a sibling of projects/, exactly the
  // real config/keys.json relationship
  await writeFile(
    path.join(tmpConfig, "keys.json"),
    JSON.stringify({ openrouter: SECRET }),
    "utf8",
  );
  process.env.CONCORD_PROJECTS_DIR = tmpProjects;
  process.env.CONCORD_CONFIG_DIR = tmpConfig;
  srv = await startServer({ port: 0 });
  base = `http://127.0.0.1:${srv.port}`;
  const created = await (
    await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Trav Probe", privacyMode: "no-training" }),
    })
  ).json();
  slug = created.data.slug;
});

after(async () => {
  await srv?.close?.();
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

// the encoded forms that survive URL parsing (new URL keeps %2f/%2e literal,
// the router decodeURIComponent's each segment) and reach a path.join
const ESCAPES = [
  "..%2f..%2f..%2fconfig%2fkeys",
  "..%2F..%2F..%2Fconfig%2Fkeys",
  "%2e%2e%2f%2e%2e%2f%2e%2e%2fconfig%2fkeys",
];

async function bodyOf(res) {
  const text = await res.text();
  return { status: res.status, text };
}

test("GET analyses/:id — traversal id cannot read the key file", async () => {
  for (const id of ESCAPES) {
    const { status, text } = await bodyOf(
      await fetch(`${base}/api/projects/${slug}/analyses/${id}`),
    );
    assert.ok(status === 400 || status === 404, `escape ${id} → ${status}, want 400/404`);
    assert.ok(!text.includes(SECRET), `escape ${id} LEAKED the secret`);
  }
});

test("GET briefs/:bid — traversal id cannot read the key file", async () => {
  for (const id of ESCAPES) {
    const { status, text } = await bodyOf(await fetch(`${base}/api/projects/${slug}/briefs/${id}`));
    assert.ok(status === 400 || status === 404, `escape ${id} → ${status}`);
    assert.ok(!text.includes(SECRET), `escape ${id} LEAKED the secret`);
  }
});

test("GET exports/methods?analysisId — traversal id cannot read the key file", async () => {
  for (const id of ESCAPES) {
    const { status, text } = await bodyOf(
      await fetch(`${base}/api/projects/${slug}/exports/methods?analysisId=${id}`),
    );
    assert.ok(status === 400 || status === 404, `escape ${id} → ${status}`);
    assert.ok(!text.includes(SECRET), `escape ${id} LEAKED the secret`);
  }
});

test("POST import/confirm — traversal importId cannot read the key file", async () => {
  for (const id of ESCAPES) {
    const { status, text } = await bodyOf(
      await fetch(`${base}/api/projects/${slug}/import/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ importId: id, mapping: {}, unitization: {} }),
      }),
    );
    assert.ok(status === 400 || status === 404, `escape ${id} → ${status}`);
    assert.ok(!text.includes(SECRET), `escape ${id} LEAKED the secret`);
  }
});

test("GET goldsets/:id — traversal id cannot read the key file", async () => {
  for (const id of ESCAPES) {
    const { status, text } = await bodyOf(
      await fetch(`${base}/api/projects/${slug}/goldsets/${id}`),
    );
    assert.ok(status === 400 || status === 404, `escape ${id} → ${status}`);
    assert.ok(!text.includes(SECRET), `escape ${id} LEAKED the secret`);
  }
});

test("GET instruments/:id — traversal id cannot read the key file", async () => {
  for (const id of ESCAPES) {
    const { status, text } = await bodyOf(
      await fetch(`${base}/api/projects/${slug}/instruments/${id}`),
    );
    assert.ok(status === 400 || status === 404, `escape ${id} → ${status}`);
    assert.ok(!text.includes(SECRET), `escape ${id} LEAKED the secret`);
  }
});

test("GET constructs/:id — traversal id cannot read the key file", async () => {
  for (const id of ESCAPES) {
    const { status, text } = await bodyOf(
      await fetch(`${base}/api/projects/${slug}/constructs/${id}`),
    );
    assert.ok(status === 400 || status === 404, `escape ${id} → ${status}`);
    assert.ok(!text.includes(SECRET), `escape ${id} LEAKED the secret`);
  }
});

test("GET corpora/:c/units — traversal corpus id cannot read the key file", async () => {
  for (const id of ESCAPES) {
    const { status, text } = await bodyOf(
      await fetch(`${base}/api/projects/${slug}/corpora/${id}/units`),
    );
    assert.ok(status === 400 || status === 404, `escape ${id} → ${status}`);
    assert.ok(!text.includes(SECRET), `escape ${id} LEAKED the secret`);
  }
});

test("traversal project slug is rejected", async () => {
  const { status, text } = await bodyOf(
    await fetch(`${base}/api/projects/${encodeURIComponent("../../config")}`),
  );
  assert.ok(status === 400 || status === 404, `slug escape → ${status}`);
  assert.ok(!text.includes(SECRET), "slug escape LEAKED the secret");
});

test("path builders (corpusUnitsFile, goldsetFile, runOutputsFile) reject a traversal id even without a route's findOr404 pre-check", () => {
  // Route handlers all check findOr404 before these builders run, so a
  // traversal id never reaches them in practice today — but that's the
  // ROUTE's guard, not the builder's. Calling the builders directly proves
  // the seam itself (safeId) still refuses a bad id if some future call
  // site skips the pre-check.
  for (const raw of ["../../../config/keys", "..\\..\\config\\keys", "a/b"]) {
    assert.throws(() => corpusUnitsFile(slug, raw), /VALIDATION|invalid corpus/i);
    assert.throws(() => goldsetFile(slug, raw), /VALIDATION|invalid goldset/i);
    assert.throws(() => runOutputsFile(slug, raw), /VALIDATION|invalid run/i);
  }
});

test("a normal id still 404s cleanly (guard does not break valid ids)", async () => {
  const { status } = await bodyOf(
    await fetch(`${base}/api/projects/${slug}/analyses/an_doesnotexist`),
  );
  assert.equal(status, 404, "a well-formed unknown id is NOT_FOUND, not VALIDATION");
});
