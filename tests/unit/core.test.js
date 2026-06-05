// Foundation tests: ids, store, ledger, objects, cache, router/server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { canonical, sha256, newId, unitId } from "../../server/core/ids.js";
import { loadProject, saveProject, appendNdjson, readNdjson, listProjects, projectsDir } from "../../server/core/store.js";
import * as ledger from "../../server/core/ledger.js";
import {
  createProject, createConstruct, createInstrument, createGoldSet, createRun, createAnalysis,
  instrumentVersionHash, versionInstrument, freeze,
} from "../../server/core/objects.js";
import * as cache from "../../server/core/cache.js";
import { ConcordError } from "../../server/core/errors.js";
import { createRouter, parseMultipart, sse } from "../../server/router.js";
import { startServer, parseServerMode, readPort } from "../../server/index.js";

async function tmpdir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "concord-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------- ids

test("ids: canonical sorts object keys recursively", () => {
  assert.equal(canonical({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
});

test("ids: canonical handles arrays, null, and drops undefined-valued keys", () => {
  assert.equal(canonical([1, "x", null]), '[1,"x",null]');
  assert.equal(canonical({ a: undefined, b: null }), '{"b":null}');
  assert.equal(canonical(null), "null");
});

test("ids: sha256 golden vector", () => {
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("ids: unitId is deterministic and input-sensitive", () => {
  assert.equal(unitId("c1", 0, "hello"), unitId("c1", 0, "hello"));
  assert.notEqual(unitId("c1", 0, "hello"), unitId("c1", 1, "hello"));
  assert.notEqual(unitId("c1", 0, "hello"), unitId("c2", 0, "hello"));
  assert.match(unitId("c1", 0, "hello"), /^u_[0-9a-f]{16}$/);
});

test("ids: newId carries prefix and is unique", () => {
  const a = newId("p");
  const b = newId("p");
  assert.match(a, /^p_[0-9a-z]+$/);
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------- store

test("store: projectsDir defaults to <root>/projects and honors CONCORD_PROJECTS_DIR", () => {
  assert.equal(path.basename(projectsDir()), "projects");
  process.env.CONCORD_PROJECTS_DIR = "C:\\elsewhere\\proj";
  try {
    assert.equal(projectsDir(), "C:\\elsewhere\\proj");
  } finally {
    delete process.env.CONCORD_PROJECTS_DIR;
  }
});

test("store: saveProject/loadProject roundtrip, atomic via tmp+rename", async (t) => {
  const dir = await tmpdir(t);
  const project = { id: "p_1", name: "Pilot", slug: "pilot", corpora: [{ id: "c1" }] };
  await saveProject(project, dir);
  assert.ok(existsSync(path.join(dir, "pilot", "project.json")));
  assert.ok(!existsSync(path.join(dir, "pilot", "project.json.tmp")), "tmp file must be renamed away");
  const loaded = await loadProject("pilot", dir);
  assert.deepEqual(loaded, project);
});

test("store: loadProject ignores a leftover .tmp from a crashed save", async (t) => {
  const dir = await tmpdir(t);
  await saveProject({ id: "p_1", name: "Good", slug: "pilot" }, dir);
  // simulate a crash mid-save: a stale half-written tmp next to the real file
  await writeFile(path.join(dir, "pilot", "project.json.tmp"), '{"id":"p_BAD","na', "utf8");
  const loaded = await loadProject("pilot", dir);
  assert.equal(loaded.name, "Good");
});

test("store: loadProject throws NOT_FOUND for a missing project", async (t) => {
  const dir = await tmpdir(t);
  await assert.rejects(loadProject("nope", dir), (err) => err.code === "NOT_FOUND");
});

test("store: appendNdjson 10k lines then readNdjson offset/limit returns exactly the last 10", async (t) => {
  const dir = await tmpdir(t);
  const file = path.join(dir, "deep", "events.ndjson");
  for (let i = 0; i < 10000; i++) await appendNdjson(file, { i });
  const rows = await readNdjson(file, { offset: 9990, limit: 10 });
  assert.equal(rows.length, 10);
  assert.deepEqual(rows[0], { i: 9990 });
  assert.deepEqual(rows[9], { i: 9999 });
});

test("store: readNdjson filter applies before offset/limit; missing file reads as []", async (t) => {
  const dir = await tmpdir(t);
  const file = path.join(dir, "f.ndjson");
  for (let i = 0; i < 20; i++) await appendNdjson(file, { i, even: i % 2 === 0 });
  const rows = await readNdjson(file, { filter: (r) => r.even, offset: 2, limit: 3 });
  assert.deepEqual(rows.map((r) => r.i), [4, 6, 8]);
  assert.deepEqual(await readNdjson(file, { limit: 0 }), []);
  assert.deepEqual(await readNdjson(path.join(dir, "absent.ndjson")), []);
});

test("store: listProjects returns saved projects and [] for a missing dir", async (t) => {
  const dir = await tmpdir(t);
  await saveProject({ id: "p_1", name: "A", slug: "a" }, dir);
  await saveProject({ id: "p_2", name: "B", slug: "b" }, dir);
  await mkdir(path.join(dir, "not-a-project")); // junk dir without project.json is skipped
  const list = await listProjects(dir);
  assert.deepEqual(list.map((p) => p.slug).sort(), ["a", "b"]);
  assert.deepEqual(await listProjects(path.join(dir, "missing")), []);
});

// ---------------------------------------------------------------- ledger

test("ledger: events hash-chain and verify ok", async (t) => {
  const dir = await tmpdir(t);
  const e1 = await ledger.append(dir, "human", "project.created", ["p_1"], { name: "Pilot" });
  const e2 = await ledger.append(dir, "director", "construct.created", ["c_1"], { name: "Optimism" });
  const e3 = await ledger.append(dir, "system", "run.started", ["run_1"], {});
  assert.equal(e1.prev, "");
  assert.equal(e2.prev, e1.hash);
  assert.equal(e3.prev, e2.hash);
  assert.equal(e1.hash, sha256("" + canonical({ ts: e1.ts, actor: e1.actor, type: e1.type, refs: e1.refs, payload: e1.payload })));
  assert.deepEqual(await ledger.verify(dir), { ok: true, length: 3 });
});

test("ledger: tampering the middle line makes verify fail at index 1", async (t) => {
  const dir = await tmpdir(t);
  await ledger.append(dir, "human", "a", ["x"], { v: 1 });
  await ledger.append(dir, "human", "b", ["y"], { v: 2 });
  await ledger.append(dir, "human", "c", ["z"], { v: 3 });
  const file = path.join(dir, "ledger.ndjson");
  const lines = (await readFile(file, "utf8")).trim().split("\n");
  const mid = JSON.parse(lines[1]);
  mid.payload.v = 999; // tamper, keeping the stored hash
  lines[1] = JSON.stringify(mid);
  await writeFile(file, lines.join("\n") + "\n", "utf8");
  const result = await ledger.verify(dir);
  assert.equal(result.ok, false);
  assert.equal(result.failedAt, 1);
  assert.equal(result.length, 3);
});

test("ledger: append chains onto an existing ledger written by a previous process", async (t) => {
  const dir = await tmpdir(t);
  // hand-write a valid first event (simulates a ledger from an earlier run)
  const body = { ts: "2026-06-05T00:00:00.000Z", actor: "human", type: "seed", refs: [], payload: {} };
  const hash = sha256("" + canonical(body));
  await appendNdjson(path.join(dir, "ledger.ndjson"), { ...body, prev: "", hash });
  const e2 = await ledger.append(dir, "human", "next", [], {});
  assert.equal(e2.prev, hash);
  assert.deepEqual(await ledger.verify(dir), { ok: true, length: 2 });
});

test("ledger: query filters by type and by ref", async (t) => {
  const dir = await tmpdir(t);
  await ledger.append(dir, "human", "construct.created", ["c_1"], {});
  await ledger.append(dir, "human", "run.started", ["run_1", "inst_1"], {});
  await ledger.append(dir, "human", "run.finished", ["run_1"], {});
  const byType = await ledger.query(dir, { type: "run.started" });
  assert.equal(byType.length, 1);
  assert.equal(byType[0].refs[1], "inst_1");
  const byRef = await ledger.query(dir, { ref: "run_1" });
  assert.deepEqual(byRef.map((e) => e.type), ["run.started", "run.finished"]);
  const both = await ledger.query(dir, { type: "run.finished", ref: "run_1" });
  assert.equal(both.length, 1);
  assert.equal((await ledger.query(dir, { ref: "ghost" })).length, 0);
});

test("ledger: verify on an empty/missing ledger is ok with length 0", async (t) => {
  const dir = await tmpdir(t);
  assert.deepEqual(await ledger.verify(dir), { ok: true, length: 0 });
});

// ---------------------------------------------------------------- cache

test("cache: key is deterministic over text|versionHash|snapshot", () => {
  const k = cache.key("some unit text", "abc123", "claude-x-2026-01-01");
  assert.equal(k, sha256("some unit text|abc123|claude-x-2026-01-01"));
  assert.equal(k, cache.key("some unit text", "abc123", "claude-x-2026-01-01"));
  assert.notEqual(k, cache.key("some unit text", "abc124", "claude-x-2026-01-01"));
});

test("cache: put/get roundtrip under cache/<first2>/<rest>; miss returns null", async (t) => {
  const dir = await tmpdir(t);
  const k = cache.key("unit", "vh", "snap");
  assert.equal(await cache.get(dir, k), null); // miss before put
  const value = { label: "yes", confidence: 0.91, rationale: "because" };
  await cache.put(dir, k, value);
  assert.ok(existsSync(path.join(dir, "cache", k.slice(0, 2), k.slice(2))));
  assert.deepEqual(await cache.get(dir, k), value);
});

// ---------------------------------------------------------------- objects

test("objects: createProject fills defaults and validates privacyMode", () => {
  const p = createProject({ name: "Pilot Study" });
  assert.match(p.id, /^p_/);
  assert.equal(p.slug, "pilot-study");
  assert.equal(p.privacyMode, "open");
  assert.deepEqual(p.budget, { capUSD: null, spentUSD: 0 });
  assert.equal(p.director, null);
  assert.deepEqual(p.corpora, []);
  assert.deepEqual(p.briefs, []);
  assert.ok(p.createdAt);
  assert.throws(() => createProject({ name: "X", privacyMode: "lax" }), (e) => e.code === "VALIDATION");
  assert.throws(() => createProject({}), (e) => e.code === "VALIDATION");
  assert.throws(() => createProject({ name: "X", slug: "Bad Slug!" }), (e) => e.code === "VALIDATION");
});

test("objects: createConstruct validates type and example kinds, fills defaults", () => {
  const c = createConstruct({
    name: "Optimism",
    type: "ordinal",
    categories: [{ value: 1, label: "low" }, { value: 2, label: "high" }],
    authoredBy: "director",
  });
  assert.match(c.id, /^c_/);
  assert.deepEqual(c.criteria, { include: [], exclude: [] });
  assert.deepEqual(c.edgeCases, []);
  assert.equal(c.humanTouched, false); // director-authored, untouched by default
  assert.equal(createConstruct({ name: "X", type: "binary" }).humanTouched, true);
  assert.throws(() => createConstruct({ name: "X", type: "vibes" }), (e) => e.code === "VALIDATION");
  assert.throws(
    () => createConstruct({ name: "X", type: "binary", examples: [{ text: "t", label: 1, kind: "meh" }] }),
    (e) => e.code === "VALIDATION");
  assert.throws(
    () => createConstruct({ name: "X", type: "continuous", scale: { min: 5, max: 1 } }),
    (e) => e.code === "VALIDATION");
});

test("objects: instrumentVersionHash is invariant to payload key insertion order", () => {
  const a = instrumentVersionHash({ prompt: "p", model: "m", params: { t: 0, k: 1 } });
  const b = instrumentVersionHash({ params: { k: 1, t: 0 }, model: "m", prompt: "p" });
  assert.equal(a, b);
  assert.notEqual(a, instrumentVersionHash({ prompt: "p2", model: "m", params: { t: 0, k: 1 } }));
});

test("objects: createInstrument fills defaults and computes versionHash from payload", () => {
  const inst = createInstrument({ constructId: "c_1", kind: "judge", payload: { prompt: "Rate {{unit}}" } });
  assert.match(inst.id, /^inst_/);
  assert.equal(inst.level, "exploratory");
  assert.equal(inst.version, 1);
  assert.equal(inst.frozen, false);
  assert.equal(inst.versionHash, instrumentVersionHash({ prompt: "Rate {{unit}}" }));
  assert.throws(() => createInstrument({ constructId: "c_1", kind: "oracle", payload: {} }), (e) => e.code === "VALIDATION");
  assert.throws(() => createInstrument({ constructId: "c_1", kind: "judge" }), (e) => e.code === "VALIDATION");
  assert.throws(
    () => createInstrument({ constructId: "c_1", kind: "judge", payload: {}, level: "perfect" }),
    (e) => e.code === "VALIDATION");
});

test("objects: versionInstrument bumps version + hash in place when unfrozen", () => {
  const inst = createInstrument({ constructId: "c_1", kind: "judge", payload: { prompt: "v1" } });
  const h1 = inst.versionHash;
  const same = versionInstrument(inst, { prompt: "v2" });
  assert.equal(same, inst); // mutates in place
  assert.equal(inst.version, 2);
  assert.notEqual(inst.versionHash, h1);
  assert.equal(inst.versionHash, instrumentVersionHash({ prompt: "v2" }));
});

test("objects: freeze seals the instrument — direct edits throw", () => {
  const inst = createInstrument({ constructId: "c_1", kind: "judge", payload: { prompt: "v1" } });
  const cert = { frozenAt: "2026-06-05T00:00:00Z", goldsetId: "gs_1", versionHash: inst.versionHash, modelPinned: true };
  freeze(inst, cert);
  assert.equal(inst.frozen, true);
  assert.deepEqual(inst.certificate, cert);
  assert.throws(() => { inst.level = "corrected"; }, TypeError);
  assert.throws(() => { inst.payload.prompt = "hacked"; }, TypeError);
  assert.throws(() => freeze(inst, cert), (e) => e.code === "VALIDATION"); // double-freeze
});

test("objects: versioning a frozen instrument forks with lineage instead of mutating", () => {
  const inst = createInstrument({ constructId: "c_1", kind: "judge", name: "Judge A", payload: { prompt: "v1" } });
  versionInstrument(inst, { prompt: "v2" });
  freeze(inst, { frozenAt: "2026-06-05T00:00:00Z", goldsetId: "gs_1", versionHash: inst.versionHash, modelPinned: true });
  const fork = versionInstrument(inst, { prompt: "v3" });
  assert.notEqual(fork, inst);
  assert.notEqual(fork.id, inst.id);
  assert.equal(fork.parentVersion, inst.versionHash);
  assert.equal(fork.version, 1);
  assert.equal(fork.frozen, false);
  assert.equal(fork.certificate, undefined);
  assert.equal(fork.constructId, inst.constructId);
  assert.equal(fork.versionHash, instrumentVersionHash({ prompt: "v3" }));
  // original untouched
  assert.equal(inst.version, 2);
  assert.deepEqual(inst.payload, { prompt: "v2" });
});

test("objects: createGoldSet / createRun / createAnalysis defaults + enum validation", () => {
  const gs = createGoldSet({ constructId: "c_1" });
  assert.match(gs.id, /^gs_/);
  assert.equal(gs.tier, "gold");
  assert.equal(gs.design, "srs");
  assert.equal(gs.status, "sampling");
  assert.deepEqual(gs.sample, []);
  assert.throws(() => createGoldSet({ constructId: "c_1", design: "vibes" }), (e) => e.code === "VALIDATION");
  assert.throws(() => createGoldSet({ constructId: "c_1", sample: [{ unitId: "u1", pi: 2 }] }), (e) => e.code === "VALIDATION");

  const run = createRun({ instrumentId: "inst_1", versionHash: "h", corpusId: "co_1", provider: "mock", model: "mock-1" });
  assert.match(run.id, /^run_/);
  assert.equal(run.status, "pending");
  assert.deepEqual(run.checkpoint, { done: 0, total: 0 });
  assert.deepEqual(run.cost, { estUSD: 0, actualUSD: 0, inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(run.quarantine, []);
  assert.equal(run.snapshot, null);
  assert.equal(run.pinned, false);
  assert.throws(() => createRun({ instrumentId: "i", versionHash: "h", corpusId: "c", provider: "mock", model: "m", status: "zombie" }),
    (e) => e.code === "VALIDATION");
  assert.throws(() => createRun({ instrumentId: "i" }), (e) => e.code === "VALIDATION");

  const an = createAnalysis({ kind: "crosstab", spec: { rows: "c_1", cols: "c_2" } });
  assert.match(an.id, /^an_/);
  assert.equal(an.level, "exploratory");
  assert.deepEqual(an.evidence, { cells: {} });
  assert.throws(() => createAnalysis({ kind: "scatter", spec: {} }), (e) => e.code === "VALIDATION");
  assert.throws(() => createAnalysis({ kind: "model" }), (e) => e.code === "VALIDATION");
});

// ---------------------------------------------------------------- server

async function startTestServer(t, opts = {}) {
  const appDir = opts.appDir ?? (await tmpdir(t));
  const srv = await startServer({ port: 0, appDir, routesDir: opts.routesDir, ...opts });
  t.after(() => srv.close());
  srv.url = `http://127.0.0.1:${srv.port}`;
  return srv;
}

test("server: /api/health returns ok + version + providers", async (t) => {
  const srv = await startTestServer(t);
  const r = await fetch(`${srv.url}/api/health`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.match(body.version, /^\d+\.\d+\.\d+/);
  assert.deepEqual(body.providers, {});
});

test("server: unknown /api/* route gets a JSON 404 envelope", async (t) => {
  const srv = await startTestServer(t);
  const r = await fetch(`${srv.url}/api/nope/missing`);
  assert.equal(r.status, 404);
  const body = await r.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "NOT_FOUND");
});

test("server: a bad percent-escape in the path is a 404, not a crash", async (t) => {
  const srv = await startTestServer(t);
  const r = await fetch(`${srv.url}/api/projects/%zz`);
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error.code, "NOT_FOUND");
});

test("server: :param routes, query parsing, JSON body parsing, ok envelope", async (t) => {
  const srv = await startTestServer(t);
  srv.router.addRoute("POST", "/api/echo/:projectId/items/:itemId", async (req, res, params) => ({
    params,
    query: req.query,
    body: req.body,
  }));
  const r = await fetch(`${srv.url}/api/echo/p%20one/items/42?x=7&y=hello`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nested: { a: 1 } }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.data.params, { projectId: "p one", itemId: "42" }); // %20 decoded
  assert.deepEqual(body.data.query, { x: "7", y: "hello" });
  assert.deepEqual(body.data.body, { nested: { a: 1 } });
});

test("server: ConcordError maps to 400 envelope, unknown errors to 500", async (t) => {
  const srv = await startTestServer(t);
  srv.router.addRoute("GET", "/api/boom/concord", async () => {
    throw new ConcordError("TEAPOT", "short and stout");
  });
  srv.router.addRoute("GET", "/api/boom/unknown", async () => {
    throw new Error("kaboom");
  });
  const r1 = await fetch(`${srv.url}/api/boom/concord`);
  assert.equal(r1.status, 400);
  assert.deepEqual(await r1.json(), { ok: false, error: { code: "TEAPOT", message: "short and stout" } });
  const r2 = await fetch(`${srv.url}/api/boom/unknown`);
  assert.equal(r2.status, 500);
  const b2 = await r2.json();
  assert.equal(b2.ok, false);
  assert.equal(b2.error.code, "INTERNAL");
});

test("server: malformed JSON body is a 400 BAD_JSON; oversize body is TOO_LARGE", async (t) => {
  const srv = await startTestServer(t);
  srv.router.addRoute("POST", "/api/json", async (req) => req.body);
  const r = await fetch(`${srv.url}/api/json`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, "BAD_JSON");

  // isolated router with a tiny limit proves the limit logic without a 50MB payload
  const { default: http } = await import("node:http");
  const router = createRouter({ appDir: await tmpdir(t), maxJsonBody: 64 });
  router.addRoute("POST", "/api/json", async (req) => req.body);
  const raw = http.createServer((req, res) => router.handle(req, res));
  await new Promise((resolve) => raw.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => raw.close(resolve)));
  const r2 = await fetch(`http://127.0.0.1:${raw.address().port}/api/json`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pad: "x".repeat(200) }),
  });
  assert.equal(r2.status, 413); // TOO_LARGE maps to 413 via the error-status table
  assert.equal((await r2.json()).error.code, "TOO_LARGE");
});

test("server: parseMultipart returns fields and file buffers", async (t) => {
  const srv = await startTestServer(t);
  srv.router.addRoute("POST", "/api/upload", async (req) => {
    const { fields, files } = await parseMultipart(req);
    return { fields, files: files.map((f) => ({ name: f.name, filename: f.filename, text: f.buffer.toString("utf8") })) };
  });
  const fd = new FormData();
  fd.append("kind", "corpus");
  fd.append("upload", new Blob(["id,text\n1,hola"], { type: "text/csv" }), "data.csv");
  const r = await fetch(`${srv.url}/api/upload`, { method: "POST", body: fd });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.data.fields, { kind: "corpus" });
  assert.deepEqual(body.data.files, [{ name: "upload", filename: "data.csv", text: "id,text\n1,hola" }]);
});

test("server: sse helper sets headers and frames events", async (t) => {
  const srv = await startTestServer(t);
  srv.router.addRoute("GET", "/api/stream", async (req, res) => {
    const s = sse(res);
    s.send("tick", { done: 1, total: 2 });
    s.send("done", { briefId: "b_1" });
    s.close();
  });
  const r = await fetch(`${srv.url}/api/stream`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /^text\/event-stream/);
  const text = await r.text();
  assert.equal(text, 'event: tick\ndata: {"done":1,"total":2}\n\nevent: done\ndata: {"briefId":"b_1"}\n\n');
});

test("server: static serving with mime map, 503 UI-not-built, traversal guard", async (t) => {
  const appDir = await tmpdir(t);
  await writeFile(path.join(appDir, "style.css"), "body{color:#1A1815}", "utf8");
  await writeFile(path.join(appDir, "tokens.json"), '{"accent":"#1F6F6B"}', "utf8");
  // secret OUTSIDE appDir must not be reachable
  const parent = path.dirname(appDir);
  const secretName = path.basename(appDir) + "-secret.txt";
  await writeFile(path.join(parent, secretName), "secret", "utf8");
  t.after(() => rm(path.join(parent, secretName), { force: true }));

  const srv = await startTestServer(t, { appDir });

  const r503 = await fetch(`${srv.url}/`);
  assert.equal(r503.status, 503);
  assert.match(await r503.text(), /UI not built/);

  const css = await fetch(`${srv.url}/style.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /^text\/css/);
  assert.equal(await css.text(), "body{color:#1A1815}");

  const json = await fetch(`${srv.url}/tokens.json`);
  assert.match(json.headers.get("content-type"), /^application\/json/);

  const missing = await fetch(`${srv.url}/nope.png`);
  assert.equal(missing.status, 404);

  const traversal = await fetch(`${srv.url}/%2e%2e/${secretName}`);
  assert.equal(traversal.status, 404);

  // once index.html exists, / serves it
  await writeFile(path.join(appDir, "index.html"), "<!doctype html><title>Concord</title>", "utf8");
  const home = await fetch(`${srv.url}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-type"), /^text\/html/);
});

test("server: auto-mounts route modules from routesDir", async (t) => {
  const routesDir = await tmpdir(t);
  await writeFile(
    path.join(routesDir, "fixture.js"),
    'export default [{ method: "GET", pattern: "/api/fixture/:id", handler: async (req, res, params) => ({ got: params.id }) }];\n',
    "utf8");
  const srv = await startTestServer(t, { routesDir });
  const r = await fetch(`${srv.url}/api/fixture/abc`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, data: { got: "abc" } });
});

test("server: parseServerMode parses --coder <goldsetId>:<coderId>", () => {
  assert.deepEqual(parseServerMode([]), { role: "full" });
  assert.deepEqual(parseServerMode(["--port", "9999"]), { role: "full" });
  assert.deepEqual(parseServerMode(["--coder", "gs_1:alice"]), { role: "coder", goldsetId: "gs_1", coderId: "alice" });
  assert.throws(() => parseServerMode(["--coder", "missing-colon"]), (e) => e.code === "VALIDATION");
  assert.throws(() => parseServerMode(["--coder"]), (e) => e.code === "VALIDATION");
});

// ------------------------------------------- regression: foundation hardening

test("store: REGRESSION concurrent saveProject never corrupts project.json (2 writers x 50 rounds)", async (t) => {
  const dir = await tmpdir(t);
  const winners = new Set();
  for (let round = 0; round < 50; round++) {
    const a = { id: "p_a", name: "A".repeat(2000), slug: "race", round };
    const b = { id: "p_b", name: "B", slug: "race", round };
    const pair = round % 2 === 0 ? [a, b] : [b, a];
    await Promise.all([saveProject(pair[0], dir), saveProject(pair[1], dir)]);
    // the file must be parseable after every round, no matter who won
    const loaded = JSON.parse(await readFile(path.join(dir, "race", "project.json"), "utf8"));
    winners.add(loaded.id);
  }
  assert.ok(winners.has("p_a") && winners.has("p_b"), `both write orders observed (saw: ${[...winners]})`);
  const leftovers = (await readdir(path.join(dir, "race"))).filter((f) => f !== "project.json");
  assert.deepEqual(leftovers, [], "no stray tmp files left behind");
});

test("store: REGRESSION updateProject is single-flight read-modify-write (20 concurrent increments)", async (t) => {
  const dir = await tmpdir(t);
  const store = await import("../../server/core/store.js");
  assert.equal(typeof store.updateProject, "function", "store must export updateProject(slug, mutatorFn, dir)");
  await saveProject({ id: "p_1", name: "Counter", slug: "counter", n: 0 }, dir);
  await Promise.all(Array.from({ length: 20 }, () => store.updateProject("counter", (p) => { p.n += 1; }, dir)));
  assert.equal((await loadProject("counter", dir)).n, 20, "no increment may be lost");
});

test("store: REGRESSION listProjects surfaces damaged bundles as {slug, corrupt: true}", async (t) => {
  const dir = await tmpdir(t);
  await saveProject({ id: "p_1", name: "Good", slug: "good" }, dir);
  await mkdir(path.join(dir, "broken"));
  await writeFile(path.join(dir, "broken", "project.json"), "{nope", "utf8");
  await mkdir(path.join(dir, "junk")); // no project.json at all — still silently skipped
  const list = await listProjects(dir);
  assert.deepEqual(list.find((p) => p.slug === "broken"), { slug: "broken", corrupt: true });
  assert.equal(list.find((p) => p.slug === "good").name, "Good");
  assert.equal(list.find((p) => p.slug === "junk"), undefined);
});

test("store: REGRESSION readNdjson skips a torn final line but still throws BAD_NDJSON elsewhere", async (t) => {
  const dir = await tmpdir(t);
  const torn = path.join(dir, "torn.ndjson");
  await writeFile(torn, '{"a":1}\n{"b":', "utf8"); // crash mid-append: no trailing newline
  assert.deepEqual(await readNdjson(torn), [{ a: 1 }], "torn tail is not corruption");

  const midfile = path.join(dir, "midfile.ndjson");
  await writeFile(midfile, '{"a":1}\nGARBAGE\n{"c":3}\n', "utf8");
  await assert.rejects(readNdjson(midfile), (e) => e.code === "BAD_NDJSON", "mid-file garbage stays a hard fail");

  const completeBad = path.join(dir, "completebad.ndjson");
  await writeFile(completeBad, '{"a":1}\nGARBAGE\n', "utf8"); // newline-terminated => a complete, malformed line
  await assert.rejects(readNdjson(completeBad), (e) => e.code === "BAD_NDJSON", "a complete malformed final line is corruption");
});

test("store: REGRESSION appendNdjson truncates a torn tail before appending", async (t) => {
  const dir = await tmpdir(t);
  const file = path.join(dir, "heal.ndjson");
  await appendNdjson(file, { a: 1 });
  await appendFile(file, '{"x":', "utf8"); // simulate a crash mid-append
  await appendNdjson(file, { b: 2 });
  const raw = await readFile(file, "utf8");
  assert.ok(raw.endsWith("\n"), "file ends with a newline after healing");
  assert.deepEqual(raw.trim().split("\n").map((l) => JSON.parse(l)), [{ a: 1 }, { b: 2 }], "fragment removed, no concatenation");
});

test("ledger: REGRESSION warm-process append after an external torn write heals instead of concatenating", async (t) => {
  const dir = await tmpdir(t);
  await ledger.append(dir, "human", "one", [], {});
  const e2 = await ledger.append(dir, "human", "two", [], {});
  await appendFile(path.join(dir, "ledger.ndjson"), '{"ts":"2026-', "utf8"); // torn external append
  assert.deepEqual(await ledger.verify(dir), { ok: true, length: 2, tornTail: true }, "torn tail is reported, not a failure");
  const e3 = await ledger.append(dir, "human", "three", [], {});
  assert.equal(e3.prev, e2.hash, "chains onto the last durable event");
  assert.deepEqual(await ledger.verify(dir), { ok: true, length: 3 });
  const lines = (await readFile(path.join(dir, "ledger.ndjson"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 3, "fragment was truncated away");
});

test("ledger: REGRESSION cold-start append heals a torn tail and chains onto the last complete event", async (t) => {
  const dir = await tmpdir(t);
  const body = { ts: "2026-06-05T00:00:00.000Z", actor: "human", type: "seed", refs: [], payload: {} };
  const hash = sha256("" + canonical(body));
  await writeFile(path.join(dir, "ledger.ndjson"), JSON.stringify({ ...body, prev: "", hash }) + "\n" + '{"ts":"2026-06-05T0', "utf8");
  const e2 = await ledger.append(dir, "human", "next", [], {});
  assert.equal(e2.prev, hash);
  assert.deepEqual(await ledger.verify(dir), { ok: true, length: 2 });
});

test("ledger: REGRESSION mid-file corruption still hard-fails verify even with torn-tail leniency", async (t) => {
  const dir = await tmpdir(t);
  await ledger.append(dir, "human", "a", [], {});
  await ledger.append(dir, "human", "b", [], {});
  const file = path.join(dir, "ledger.ndjson");
  const lines = (await readFile(file, "utf8")).trim().split("\n");
  await writeFile(file, "GARBAGE\n" + lines[1] + "\n", "utf8");
  const result = await ledger.verify(dir);
  assert.equal(result.ok, false);
});

test("ledger: REGRESSION stat-checks the cached tail so an external append is not orphaned", async (t) => {
  const dir = await tmpdir(t);
  const e1 = await ledger.append(dir, "human", "one", [], {});
  // a second process appends a valid event behind our back
  const body = { ts: "2026-06-05T00:00:00.000Z", actor: "human", type: "two", refs: [], payload: {} };
  const hash = sha256(e1.hash + canonical(body));
  await appendNdjson(path.join(dir, "ledger.ndjson"), { ...body, prev: e1.hash, hash });
  const e3 = await ledger.append(dir, "human", "three", [], {});
  assert.equal(e3.prev, hash, "must chain onto the externally appended event, not the stale cached tail");
  assert.deepEqual(await ledger.verify(dir), { ok: true, length: 3 });
});

test("ledger: 20 parallel appends serialize into a verifiable chain", async (t) => {
  const dir = await tmpdir(t);
  await Promise.all(Array.from({ length: 20 }, (_, i) => ledger.append(dir, "system", "tick", [], { i })));
  const result = await ledger.verify(dir);
  assert.deepEqual(result, { ok: true, length: 20 });
});

test("ids: REGRESSION canonical honors toJSON (Date)", () => {
  assert.equal(canonical(new Date(0)), JSON.stringify("1970-01-01T00:00:00.000Z"));
  assert.equal(canonical({ at: new Date(0), n: 1 }), '{"at":"1970-01-01T00:00:00.000Z","n":1}');
  assert.equal(canonical([new Date(0)]), '["1970-01-01T00:00:00.000Z"]');
});

test("ledger: REGRESSION a Date in the payload does not brick verify (hash-what-you-persist)", async (t) => {
  const dir = await tmpdir(t);
  const e = await ledger.append(dir, "human", "ran", [], { at: new Date("2026-06-05T01:02:03.456Z"), n: 1 });
  assert.equal(e.payload.at, "2026-06-05T01:02:03.456Z", "payload is normalized to what JSON persists");
  assert.deepEqual(await ledger.verify(dir), { ok: true, length: 1 });
});

test("objects: REGRESSION createInstrument rejects frozen:true input", () => {
  assert.throws(
    () => createInstrument({ constructId: "c_1", kind: "judge", payload: {}, frozen: true }),
    (e) => e.code === "VALIDATION");
});

test("store: REGRESSION frozen instruments stay frozen after loadProject (rehydrate)", async (t) => {
  const dir = await tmpdir(t);
  const inst = createInstrument({ constructId: "c_1", kind: "judge", payload: { prompt: "v1" } });
  freeze(inst, { frozenAt: "2026-06-05T00:00:00Z", goldsetId: "gs_1", versionHash: inst.versionHash, modelPinned: true });
  const project = createProject({ name: "Frozen Pilot" });
  project.instruments.push(inst);
  await saveProject(project, dir);
  const got = (await loadProject("frozen-pilot", dir)).instruments[0];
  assert.equal(got.frozen, true);
  assert.throws(() => { got.payload.prompt = "hacked"; }, TypeError, "payload edits must throw after rehydration");
  assert.throws(() => { got.level = "corrected"; }, TypeError);
});

test("store: REGRESSION loadProject validates instrument enums on rehydrate", async (t) => {
  const dir = await tmpdir(t);
  await mkdir(path.join(dir, "badinst"));
  const project = { id: "p_1", name: "Bad", slug: "badinst", instruments: [{ id: "i1", kind: "wizard", level: "exploratory", frozen: false, payload: {} }] };
  await writeFile(path.join(dir, "badinst", "project.json"), JSON.stringify(project), "utf8");
  await assert.rejects(loadProject("badinst", dir), (e) => e.code === "VALIDATION");
});

test("objects: REGRESSION versionInstrument resets ladder state on the unfrozen path", () => {
  const inst = createInstrument({
    constructId: "c_1", kind: "judge", payload: { p: 1 },
    level: "calibrated", stability: { runs: 3 }, silver: { n: 200 },
  });
  versionInstrument(inst, { p: 2 });
  assert.equal(inst.version, 2);
  assert.equal(inst.level, "exploratory", "evidence level resets when the payload changes");
  assert.equal(inst.stability, undefined);
  assert.equal(inst.silver, undefined);
  assert.equal(inst.certificate, undefined);
});

test("objects: REGRESSION freeze survives cyclic payloads (freeze before recurse)", () => {
  const inst = createInstrument({ constructId: "c_1", kind: "judge", payload: { a: {} } });
  inst.payload.a.self = inst.payload; // cycle introduced after hashing
  freeze(inst, { frozenAt: "2026-06-05T00:00:00Z", goldsetId: "gs_1", versionHash: inst.versionHash, modelPinned: true });
  assert.ok(Object.isFrozen(inst.payload.a));
  assert.ok(Object.isFrozen(inst.payload));
});

test("cache: torn cache write reads as a miss", async (t) => {
  const dir = await tmpdir(t);
  const k = cache.key("u", "v", "s");
  const file = path.join(dir, "cache", k.slice(0, 2), k.slice(2));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '{"label":"ye', "utf8");
  assert.equal(await cache.get(dir, k), null);
});

test("cache: REGRESSION put removes its tmp file when the rename fails", async (t) => {
  const dir = await tmpdir(t);
  const k = cache.key("u2", "v2", "s2");
  const file = path.join(dir, "cache", k.slice(0, 2), k.slice(2));
  await mkdir(file, { recursive: true }); // a directory squatting on the entry path forces rename to fail
  await assert.rejects(cache.put(dir, k, { x: 1 }));
  const left = (await readdir(path.dirname(file))).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(left, [], "tmp file must be cleaned up on the failure path");
});

test("errors: REGRESSION ConcordError carries an explicit status and a cause", () => {
  const root = new Error("root cause");
  const e = new ConcordError("X", "msg", { a: 1 }, { status: 418, cause: root });
  assert.equal(e.status, 418);
  assert.equal(e.cause, root);
  assert.equal(e.code, "X");
  assert.deepEqual(e.details, { a: 1 });
  assert.equal(new ConcordError("Y", "m").status, undefined, "status is optional; the router maps codes");
});

test("server: REGRESSION ConcordError codes map onto proper HTTP statuses", async (t) => {
  const srv = await startTestServer(t);
  const cases = [
    ["NOT_FOUND", 404], ["TOO_LARGE", 413], ["PRIVACY_BLOCKED", 403],
    ["RATE_LIMITED_EXHAUSTED", 503], ["VALIDATION", 400], ["BAD_JSON", 400],
    ["SCHEMA_INVALID", 400], ["CONFIG_MISSING", 400], ["MYSTERY_CODE", 400],
  ];
  for (const [code] of cases) {
    srv.router.addRoute("GET", `/api/err/${code}`, async () => { throw new ConcordError(code, `boom ${code}`); });
  }
  srv.router.addRoute("GET", "/api/err/explicit", async () => {
    throw new ConcordError("NOT_FOUND", "teapot wins", {}, { status: 418 });
  });
  for (const [code, status] of cases) {
    const r = await fetch(`${srv.url}/api/err/${code}`);
    assert.equal(r.status, status, `${code} must map to ${status}`);
    assert.equal((await r.json()).error.code, code);
  }
  const r = await fetch(`${srv.url}/api/err/explicit`);
  assert.equal(r.status, 418, "an explicit status beats the per-code map");
});

test("server: REGRESSION static stream open failure does not crash the server", async (t) => {
  const appDir = await tmpdir(t);
  await writeFile(path.join(appDir, "real.txt"), "hello", "utf8");
  await writeFile(path.join(appDir, "alive.txt"), "alive", "utf8");
  const { createReadStream } = await import("node:fs");
  const { stat } = await import("node:fs/promises");
  // stat sees the real file, but the open happens on a path deleted in between
  const fsImpl = {
    stat,
    createReadStream: (file) => createReadStream(file.includes("real.txt") ? path.join(appDir, "vanished-between-stat-and-open") : file),
  };
  const router = createRouter({ appDir, fsImpl });
  const { default: http } = await import("node:http");
  const raw = http.createServer((req, res) => router.handle(req, res));
  await new Promise((resolve) => raw.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { raw.closeAllConnections?.(); raw.close(resolve); }));
  const url = `http://127.0.0.1:${raw.address().port}`;
  const first = await fetch(`${url}/real.txt`).then((r) => r.text()).catch(() => "CONNECTION_DESTROYED");
  assert.notEqual(first, "hello", "the injected fs seam must be honored (open must fail)");
  // the server process survived the stream error and still serves
  const second = await fetch(`${url}/alive.txt`);
  assert.equal(second.status, 200);
  assert.equal(await second.text(), "alive");
});

test("server: REGRESSION parseMultipart enforces the file size limit (TOO_LARGE -> 413)", async (t) => {
  const srv = await startTestServer(t);
  srv.router.addRoute("POST", "/api/upload-limited", async (req) => {
    const { files } = await parseMultipart(req, { maxFileSize: 64 });
    return { n: files.length };
  });
  const fd = new FormData();
  fd.append("upload", new Blob(["x".repeat(4096)], { type: "text/plain" }), "big.txt");
  const r = await fetch(`${srv.url}/api/upload-limited`, { method: "POST", body: fd });
  assert.equal(r.status, 413);
  assert.equal((await r.json()).error.code, "TOO_LARGE");
});

test("server: REGRESSION parseMultipart settles (rejects) when the client aborts mid-upload", async (t) => {
  const srv = await startTestServer(t);
  let settle;
  const outcome = new Promise((resolve) => { settle = resolve; });
  srv.router.addRoute("POST", "/api/upload-abort", async (req) => {
    try {
      await parseMultipart(req);
      settle("resolved");
    } catch (err) {
      settle(`rejected:${err.code}`);
    }
    return null;
  });
  const net = await import("node:net");
  const sock = net.connect(srv.port, "127.0.0.1");
  await new Promise((resolve) => sock.on("connect", resolve));
  const boundary = "----concordtestboundary";
  sock.write(
    `POST /api/upload-abort HTTP/1.1\r\nhost: 127.0.0.1\r\n` +
    `content-type: multipart/form-data; boundary=${boundary}\r\ncontent-length: 100000\r\n\r\n` +
    `--${boundary}\r\ncontent-disposition: form-data; name="f"; filename="x.bin"\r\n` +
    `content-type: application/octet-stream\r\n\r\npartial bytes only...`);
  await new Promise((resolve) => setTimeout(resolve, 150)); // let the handler start parsing
  sock.destroy(); // client walks away mid-body
  const result = await Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve("HUNG"), 3000))]);
  assert.match(String(result), /^rejected:/, `parseMultipart must settle on abort (got: ${result})`);
});

test("server: REGRESSION sse exposes closed + onClose wired to client disconnect", async (t) => {
  const srv = await startTestServer(t);
  let conn;
  let sawClose;
  const closedSignal = new Promise((resolve) => { sawClose = resolve; });
  srv.router.addRoute("GET", "/api/stream-hold", async (req, res) => {
    conn = sse(res);
    assert.equal(conn.closed, false, "sse() must expose a closed boolean");
    conn.onClose(() => sawClose("closed"));
    conn.send("tick", { i: 1 });
    // intentionally never conn.close() — the client will disconnect
  });
  const ac = new AbortController();
  const r = await fetch(`${srv.url}/api/stream-hold`, { signal: ac.signal });
  await r.body.getReader().read(); // first tick arrived; handler ran
  ac.abort();
  const result = await Promise.race([closedSignal, new Promise((resolve) => setTimeout(() => resolve("HUNG"), 3000))]);
  assert.equal(result, "closed", "onClose must fire when the client disconnects");
  assert.equal(conn.closed, true);
});

test("server: REGRESSION close() returns promptly with a live SSE connection", async (t) => {
  const srv = await startServer({ port: 0, appDir: await tmpdir(t) });
  t.after(() => { srv.server.closeAllConnections?.(); return new Promise((resolve) => srv.server.close(resolve)); });
  srv.router.addRoute("GET", "/api/stream-hold2", async (req, res) => {
    sse(res).send("tick", { i: 1 }); // held open forever
  });
  const r = await fetch(`http://127.0.0.1:${srv.port}/api/stream-hold2`);
  await r.body.getReader().read();
  const result = await Promise.race([
    srv.close().then(() => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("HUNG"), 3000)),
  ]);
  assert.equal(result, "closed", "close() must not wait forever on live connections");
});

test("server: REGRESSION traversal guard blocks backslash escapes (/..%5C)", async (t) => {
  const appDir = await tmpdir(t);
  await writeFile(path.join(appDir, "ok.txt"), "ok", "utf8");
  const parent = path.dirname(appDir);
  const secretName = path.basename(appDir) + "-bs-secret.txt";
  await writeFile(path.join(parent, secretName), "secret", "utf8");
  t.after(() => rm(path.join(parent, secretName), { force: true }));
  const srv = await startTestServer(t, { appDir });
  for (const probe of [`/..%5C${secretName}`, `/%2e%2e%5C${secretName}`, `/..%2F${secretName}`]) {
    const r = await fetch(`${srv.url}${probe}`);
    assert.equal(r.status, 404, `probe ${probe} must be blocked`);
    assert.notEqual(await r.text(), "secret", `probe ${probe} must not leak the file`);
  }
});

test("server: readPort falls back to 7341 when config is absent or malformed", async (t) => {
  const dir = await tmpdir(t);
  assert.equal(await readPort(path.join(dir, "config", "app.json")), 7341); // missing dir — no crash
  await mkdir(path.join(dir, "config"), { recursive: true });
  await writeFile(path.join(dir, "config", "app.json"), '{"port": 8123}', "utf8");
  assert.equal(await readPort(path.join(dir, "config", "app.json")), 8123);
  await writeFile(path.join(dir, "config", "app.json"), "{oops", "utf8");
  assert.equal(await readPort(path.join(dir, "config", "app.json")), 7341);
});
