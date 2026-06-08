// Lifecycle / robustness fixes — pins the review bugs whose home is the
// process and request lifecycle:
//
//   1. [bug 1] a runtime 'error' on the http.Server (and the ::1 mirror, and
//      coder listeners) must be LOGGED and survived, never rethrown as an
//      uncaught exception that kills the process and every background run.
//      installProcessGuards() adds the last-resort uncaught/unhandled logger.
//   2. [bug 2 — brief] generateBrief honors an AbortSignal: a client that
//      disconnects before the one paid Director call spends nothing (the
//      cooperative check fires BEFORE callDirector). Silver-tune's signal is
//      deferred (its loop lives in server/director/silver.js, a non-owned
//      file) — see the suite footer note.
//   3. [bug 3] a coder listener that dies marks its session dead and fires the
//      onDead eviction hook, so the session registry never hands back a dead
//      url.
//   4. [bug 4] panel confidenceWeighted rejects a negative confidence (parity
//      with reliabilityWeighted).
//   5. [bug 5] the methods stateHash commits to instrument.silver, so a
//      post-hoc edit of the silver curve changes the hash.
//
// Harness: a real server on an ephemeral port over a temp CONCORD_PROJECTS_DIR
// / CONCORD_CONFIG_DIR, MockModel as the Director with a call-counting handler
// selected via the director slot's systemSuffix ("[[handler:lifecycle]]").
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  startServer, startCoderListener, attachServerErrorLogger, installProcessGuards,
} from "../../server/index.js";
import { getAdapter } from "../../server/providers/registry.js";
import { appendNdjson, updateProject } from "../../server/core/store.js";
import { generateBrief } from "../../server/director/brief.js";
import { aggregate } from "../../server/instruments/panel.js";
import * as methods from "../../server/reporting/methods.js";
import * as ledger from "../../server/core/ledger.js";
import {
  createProject, createConstruct, createInstrument, createAnalysis,
} from "../../server/core/objects.js";
import { saveProject } from "../../server/core/store.js";
import { ConcordError } from "../../server/core/errors.js";

// ---------------------------------------------------------------- harness

let tmpProjects;
let tmpConfig;
let srv;
let base;

// the Director handler counts calls so the abort test can assert "0 calls
// when the signal is already aborted, ≥1 otherwise"
const DIRECTOR = { calls: 0 };
function briefHandler() {
  DIRECTOR.calls += 1;
  // a minimal BRIEF_SCHEMA-valid object (refs are filtered against the shown
  // sample, so empty ref arrays are fine — the brief just records zero claims)
  return {
    unitOfAnalysis: "One response per row.",
    paragraphs: [{ md: "Respondents discuss pay.", refs: [] }],
    themes: [{ name: "Pay", definition: "Compensation talk.", quoteRefs: [] }],
    redFlags: [],
    suggestedQuestions: [],
  };
}

before(async () => {
  tmpProjects = await mkdtemp(path.join(os.tmpdir(), "concord-lifecycle-"));
  tmpConfig = await mkdtemp(path.join(os.tmpdir(), "concord-lifecycle-cfg-"));
  process.env.CONCORD_PROJECTS_DIR = tmpProjects;
  process.env.CONCORD_CONFIG_DIR = tmpConfig;
  srv = await startServer({ port: 0 });
  base = `http://127.0.0.1:${srv.port}`;
  // network-backed catalogs must not leave the machine during tests
  for (const name of ["openrouter", "ollama"]) {
    const { adapter } = getAdapter({ privacyMode: "open" }, name);
    adapter.catalog = async () => [];
  }
  const mock = getAdapter({ privacyMode: "open" }, "mock").adapter;
  mock.setHandler("lifecycle", briefHandler);
});

after(async () => {
  await srv?.close();
  delete process.env.CONCORD_PROJECTS_DIR;
  delete process.env.CONCORD_CONFIG_DIR;
  await rm(tmpProjects, { recursive: true, force: true }).catch(() => {});
  await rm(tmpConfig, { recursive: true, force: true }).catch(() => {});
});

// =========================================================================
// bug 1: a runtime server 'error' is logged and survived, not fatal
// =========================================================================

test("bug1: the running http.Server has a persistent 'error' listener — a synthetic emit does not throw", () => {
  // after a successful listen, startServer swaps the reject-on-error wiring
  // for the persistent logger; with it attached, emitting 'error' is caught by
  // the listener instead of being rethrown by EventEmitter as an exception
  assert.ok(srv.server.listenerCount("error") >= 1,
    "the live server must carry at least one persistent 'error' listener");
  // emitting on an EventEmitter with >=1 'error' listener does NOT throw; with
  // zero listeners it WOULD throw (the pre-fix crash). This asserts no throw
  // escapes — equivalent to "the process survives a runtime accept failure".
  assert.doesNotThrow(() => srv.server.emit("error", Object.assign(new Error("synthetic EMFILE"), { code: "EMFILE" })),
    "a runtime server error must be swallowed by the persistent handler, not rethrown");
});

test("bug1: attachServerErrorLogger installs a non-throwing handler on an arbitrary server", () => {
  const s = http.createServer();
  assert.equal(s.listenerCount("error"), 0, "a fresh server starts with no error listener");
  attachServerErrorLogger(s, "unit");
  assert.equal(s.listenerCount("error"), 1);
  assert.doesNotThrow(() => s.emit("error", new Error("boom")),
    "the attached handler logs and returns — the error does not propagate");
  s.close();
});

test("bug1: installProcessGuards is idempotent and registers the last-resort loggers", () => {
  const before_ = {
    unc: process.listenerCount("uncaughtException"),
    unh: process.listenerCount("unhandledRejection"),
  };
  installProcessGuards();
  installProcessGuards(); // second call must be a no-op (no listener stacking)
  // startServer already installed them in before(); the count is steady and
  // at least one guard of each kind is present
  assert.ok(process.listenerCount("uncaughtException") >= 1, "uncaughtException guard present");
  assert.ok(process.listenerCount("unhandledRejection") >= 1, "unhandledRejection guard present");
  assert.equal(process.listenerCount("uncaughtException"), before_.unc,
    "repeated installProcessGuards must not stack uncaughtException listeners");
  assert.equal(process.listenerCount("unhandledRejection"), before_.unh,
    "repeated installProcessGuards must not stack unhandledRejection listeners");
});

// =========================================================================
// bug 3: a dead coder listener marks its session dead and fires onDead
// =========================================================================

test("bug3: a coder listener that loses its server marks the session dead and fires onDead exactly once", async () => {
  // a project + a goldset are not needed: startCoderListener binds the ids and
  // opens a restricted listener; the registry-hygiene wiring is independent of
  // any coding state.
  let evicted = null;
  let evictions = 0;
  const session = await startCoderListener("any-slug", "gs_x", "coder_1", {
    onDead: (s) => { evictions += 1; evicted = s; },
  });
  assert.equal(session.dead, false, "a fresh session is alive");
  assert.equal(typeof session.port, "number");

  // simulate the listener dying under the cached session
  session.server.emit("error", Object.assign(new Error("listener fault"), { code: "ECONNRESET" }));
  assert.equal(session.dead, true, "the session is marked dead when its server errors");
  assert.equal(evictions, 1, "onDead fired exactly once");
  assert.equal(evicted, session, "onDead receives the dead session so the map owner can drop it");

  // a subsequent 'close' must NOT double-fire the eviction
  session.server.emit("close");
  assert.equal(evictions, 1, "reaping is once-only — error then close does not re-evict");

  await session.close().catch(() => {});
});

// =========================================================================
// bug 4: confidenceWeighted rejects a negative confidence (parity)
// =========================================================================

test("bug4: confidenceWeighted aggregation throws on a negative-confidence juror", () => {
  const payload = { aggregation: "confidenceWeighted" };
  // a well-formed positive-confidence panel still aggregates
  const okVerdict = aggregate(
    [{ juror: "a", label: "yes", confidence: 0.9 }, { juror: "b", label: "no", confidence: 0.2 }],
    payload,
  );
  assert.equal(okVerdict.label, "yes", "valid confidences still produce a weighted verdict");

  // a negative confidence must fail rather than vote against its own label
  assert.throws(
    () => aggregate(
      [{ juror: "a", label: "yes", confidence: -1 }, { juror: "b", label: "no", confidence: 0.5 }],
      payload,
    ),
    (e) => e instanceof ConcordError && e.code === "VALIDATION" && /confidence weights must be numbers >= 0/.test(e.message),
    "a negative confidence weight must be rejected (parity with reliabilityWeighted)",
  );

  // reliabilityWeighted's pre-existing guard still holds (regression anchor)
  assert.throws(
    () => aggregate(
      [{ juror: "a", label: "yes" }, { juror: "b", label: "no" }],
      { aggregation: "reliabilityWeighted" },
      { a: -2 },
    ),
    (e) => e instanceof ConcordError && e.code === "VALIDATION" && /reliability weights must be numbers >= 0/.test(e.message),
  );
});

// =========================================================================
// bug 2 (brief): generateBrief honors an AbortSignal before the paid call
// =========================================================================

const BRIEF = { slug: "brief-abort-demo", corpusId: "corp_b" };

async function buildBriefProject() {
  // a project saved through the store, with a director slot pointed at the
  // call-counting mock handler, and a small corpus on disk
  const project = createProject({
    name: "Brief Abort Demo",
    slug: BRIEF.slug,
    privacyMode: "open",
    corpora: [{
      id: BRIEF.corpusId, name: "Survey", source: { filename: "s.csv", format: "csv", rows: 6 },
      unitization: { scheme: "response" }, unitCount: 6, textColumn: "response", metaColumns: 1,
    }],
    director: { provider: "mock", model: "mock-1", snapshot: "mock-1", systemSuffix: "[[handler:lifecycle]]" },
  });
  await saveProject(project, tmpProjects);
  for (let i = 0; i < 6; i++) {
    await appendNdjson(path.join(tmpProjects, BRIEF.slug, "corpora", BRIEF.corpusId, "units.ndjson"),
      { id: `u_${"0".repeat(13)}${i.toString(16)}`, text: `Pay was too low and the salary never improved ${i}.`, meta: { dept: i % 2 ? "sales" : "ops" } });
  }
  return project;
}

test("bug2-brief: an already-aborted signal stops generateBrief BEFORE the Director call (zero model calls)", async () => {
  const project = await buildBriefProject();
  const ac = new AbortController();
  ac.abort(); // the client already disconnected

  const callsBefore = DIRECTOR.calls;
  await assert.rejects(
    generateBrief(project, BRIEF.corpusId, { signal: ac.signal }),
    (e) => e instanceof ConcordError && e.code === "ABORTED",
    "generateBrief must throw ABORTED when the signal is already aborted",
  );
  assert.equal(DIRECTOR.calls, callsBefore,
    "no Director call may be spent once the client has disconnected (count unchanged)");
});

test("bug2-brief: without an abort, generateBrief makes exactly one Director call and returns a brief", async () => {
  const project = await buildBriefProject();
  const callsBefore = DIRECTOR.calls;
  const brief = await generateBrief(project, BRIEF.corpusId, {});
  assert.equal(DIRECTOR.calls, callsBefore + 1, "the happy path spends exactly one Director call");
  assert.match(brief.id, /^brief_/);
  assert.equal(brief.corpusId, BRIEF.corpusId);
  assert.ok(Array.isArray(brief.paragraphs), "a brief came back");
});

test("bug2-brief: aborting after the first stage and before the call still spends nothing", async () => {
  const project = await buildBriefProject();
  const ac = new AbortController();
  const callsBefore = DIRECTOR.calls;
  // fire the abort the instant the FIRST honest stage reports (sampling) —
  // this is the "disconnect mid-stream, before the paid call" path; the
  // pre-call check then trips and no Director call is made
  await assert.rejects(
    generateBrief(project, BRIEF.corpusId, {
      signal: ac.signal,
      onStage: (event) => { if (event === "sampling") ac.abort(); },
    }),
    (e) => e instanceof ConcordError && e.code === "ABORTED",
  );
  assert.equal(DIRECTOR.calls, callsBefore,
    "a disconnect during sampling/prompt composition must not reach the Director call");
});

// =========================================================================
// bug 5: methods stateHash commits to instrument.silver
// =========================================================================

const HASH = { slug: "statehash-demo", dir: null };

async function buildStateHashProject() {
  const dir = path.join(tmpProjects, HASH.slug);
  const corpusId = "corp_sh";
  const construct = createConstruct({
    id: "c_sh", name: "Pay concern", type: "binary",
    definition: "Mentions of pay as a concern.",
    criteria: { include: ["pay complaints"], exclude: [] }, edgeCases: [], examples: [],
    authoredBy: "human", humanTouched: true,
  });
  const instrument = createInstrument({
    id: "inst_sh", constructId: construct.id, kind: "judge", name: "Pay judge",
    payload: {
      provider: "mock", model: "mock-1", snapshot: "mock-1",
      params: { temperature: 0, maxTokens: 64 },
      promptTemplate: "Judge. {{definition}} {{criteria}} {{examples}} {{unit}}",
      schema: { type: "binary" }, rationaleFirst: true, workerClass: "mid",
    },
    authoredBy: "director", humanTouched: true,
  });
  // a silver curve whose last agreement the methods prose prints (§5)
  instrument.silver = {
    goldsetId: "gs_sh",
    iterations: [{ versionHash: instrument.versionHash, agreement: 0.80, note: "baseline" }],
  };
  instrument.level = "stabilized";

  const analysis = createAnalysis({
    id: "an_sh", kind: "descriptive",
    spec: { instrumentId: instrument.id, corpusId, measure: "prevalence" },
    results: { estimator: "naive-proportion", outcome: "pay", groupBy: null, cells: [{ group: "all", n: 6, est: 0.5 }] },
    level: "exploratory",
    createdAt: "2026-06-02T11:00:00.000Z",
  });

  const project = createProject({
    id: "p_sh", name: "StateHash Demo", slug: HASH.slug, privacyMode: "open",
    corpora: [{ id: corpusId, name: "Survey", source: { filename: "s.csv", format: "csv", rows: 6 }, unitization: { scheme: "response" }, unitCount: 6 }],
    constructs: [construct],
    instruments: [instrument],
    analyses: [{ id: analysis.id, kind: analysis.kind, level: analysis.level, createdAt: analysis.createdAt }],
  });
  await saveProject(project, tmpProjects);
  // generate() needs the analysis on disk (loadAnalysis prefers the file) and
  // at least one ledger event to anchor citations
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(path.join(dir, "analyses"), { recursive: true });
  await writeFile(path.join(dir, "analyses", "an_sh.json"), JSON.stringify(analysis, null, 2), "utf8");
  await ledger.append(dir, "system", "project.created", { projectId: project.id }, { name: project.name });
  await ledger.append(dir, "human", "instrument.created", { instrumentId: instrument.id }, { kind: "judge" });
  await ledger.append(dir, "system", "analysis.created", { analysisId: analysis.id }, { kind: "descriptive", level: "exploratory" });

  HASH.dir = dir;
  return project;
}

test("bug5: two instruments differing ONLY in silver.iterations produce different stateHashes", async () => {
  const project = await buildStateHashProject();
  const hashOf = async (proj) => {
    await methods.generate(proj, "an_sh", { projectDir: HASH.dir });
    const evs = await ledger.query(HASH.dir, { type: "export.methods" });
    return evs[evs.length - 1].payload.stateHash;
  };

  const h1 = await hashOf(project);
  const h1again = await hashOf(project);
  assert.equal(h1, h1again, "stateHash is deterministic for identical state");

  // mutate ONLY the silver curve's last agreement — the number the prose
  // prints. Before the fix this rode outside the hashed tuple and a post-hoc
  // edit went unnoticed by a preview; now it must move the hash.
  const editedSilver = structuredClone(project);
  editedSilver.instruments[0].silver.iterations.at(-1).agreement = 0.97;
  const h2 = await hashOf(editedSilver);
  assert.notEqual(h1, h2, "editing silver.iterations must change the stateHash");

  // adding a silver iteration likewise changes it
  const moreIters = structuredClone(project);
  moreIters.instruments[0].silver.iterations.push({ versionHash: "x", agreement: 0.91, note: "added" });
  const h3 = await hashOf(moreIters);
  assert.notEqual(h1, h3, "appending a silver iteration must change the stateHash");

  // dropping silver entirely (null) is distinct from a present silver curve
  const noSilver = structuredClone(project);
  delete noSilver.instruments[0].silver;
  const h4 = await hashOf(noSilver);
  assert.notEqual(h1, h4, "removing silver entirely must change the stateHash");
});

// -------------------------------------------------------------------------
// DEFERRED (reported, not implemented here): bug 2 for POST /silver-tune. The
// abort must be honored by a between-iteration check INSIDE silverTune, whose
// loop lives in server/director/silver.js — a file this task does not own.
// The owned route (server/routes/instruments.js) can open the AbortController,
// but wiring a signal that silverTune ignores would be dead code, so it is
// left for the silver.js owner. The brief path (above) is implemented in full.
