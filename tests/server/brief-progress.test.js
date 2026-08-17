// Brief progress over SSE — pins that POST /api/projects/:p/brief reports
// the stages the server actually knows instead of going silent for the one
// long Director call (the recorded gap: 30–60s of composing wait with no
// events).
//
// Contract under test (event order on the stream):
//   sampling {sampleN, unitCount}      → the stratified sample is drawn
//   prompt-composed {chars}            → the prompt is built
//   director-called {provider, model}  → the one long call starts
//   tick {elapsed}                     → every ~2s WHILE the call is in
//                                        flight; the timer is cleared when
//                                        the call settles (resolve or reject)
//   validating {sampleN}               → refs checked against the shown sample
//   para … done                        → unchanged existing taxonomy
//
// No fake percentages anywhere: every event states something the server
// knows to be true at that moment.
//
// Harness mirrors tests/server/pii-reunitize.test.js: the real server on an
// ephemeral port over temp CONCORD_PROJECTS_DIR / CONCORD_CONFIG_DIR; the
// mock Director is slowed via the established [[handler:…]] mechanism so at
// least one tick fires. Tests run serially in declaration order.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startServer } from "../../server/index.js";
import { loadProject } from "../../server/core/store.js";
import { getAdapter } from "../../server/providers/registry.js";
import { generateBrief } from "../../server/director/brief.js";

// ---------------------------------------------------------------- harness

let tmpProjects;
let tmpConfig;
let srv;
let base;

before(async () => {
  tmpProjects = await mkdtemp(path.join(os.tmpdir(), "concord-brief-prog-"));
  tmpConfig = await mkdtemp(path.join(os.tmpdir(), "concord-brief-prog-cfg-"));
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

// Consume a complete SSE stream (the route closes it when done).
async function readSse(p, { method = "GET", body } = {}) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + p, init);
  if (!res.headers.get("content-type")?.includes("text/event-stream")) {
    const text = await res.text();
    return { status: res.status, events: [], raw: text };
  }
  const text = await res.text();
  const events = [];
  for (const block of text.split(/\n\n/)) {
    if (!block.trim()) continue;
    let event = "message";
    const data = [];
    for (const line of block.split(/\n/)) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      else if (line.startsWith("data: ")) data.push(line.slice(6));
    }
    if (data.length) events.push({ event, data: JSON.parse(data.join("\n")) });
  }
  return { status: res.status, events };
}

// ----------------------------------------------------------- mock director

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mock = () => getAdapter({ privacyMode: "open" }, "mock").adapter;
const lastUser = (req) => [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
const shownUnitIds = (t) => [
  ...new Set([...String(t).matchAll(/unit (u_[0-9a-f]{16})/g)].map((m) => m[1])),
];

// A schema-valid brief citing only shown units, after `delayMs` in flight —
// long enough for the route's ~2s ticker to fire at least once.
function briefAnswer(req) {
  const ids = shownUnitIds(lastUser(req));
  return {
    unitOfAnalysis: "one survey response per row",
    paragraphs: [
      { md: "Respondents talk mostly about compensation.", refs: [ids[0]] },
      { md: "A second cluster praises the team.", refs: [ids[1]] },
    ],
    themes: [
      { name: "Pay", definition: "Complaints about compensation level.", quoteRefs: [ids[0]] },
    ],
    redFlags: [],
    suggestedQuestions: ["Which departments complain about pay?"],
  };
}

// ----------------------------------------------------------------- fixture

const UNIT_ROWS = 12;

function makeCsv() {
  const lines = ["respondent_id,dept,response"];
  for (let i = 0; i < UNIT_ROWS; i++) {
    const text =
      i % 3 === 0
        ? `the salary is too low for this work and it never improves around here ${i}`
        : `the office is comfortable and the team is genuinely kind to newcomers ${i}`;
    lines.push(`r${i},${i % 2 ? "sales" : "ops"},${text}`);
  }
  return lines.join("\n") + "\n";
}

const SLUG = "brief-progress";
let corpusId = null;

async function setup() {
  await ok("POST", "/api/projects", { name: "Brief Progress", slug: SLUG });
  await ok("PUT", "/api/settings", {
    project: {
      slug: SLUG,
      director: {
        provider: "mock",
        model: "mock-1",
        snapshot: "mock-1",
        systemSuffix: "[[handler:brief-progress]]",
      },
    },
  });
  const up = await upload(`/api/projects/${SLUG}/import`, "survey.csv", makeCsv());
  const confirmed = await ok("POST", `/api/projects/${SLUG}/import/confirm`, {
    importId: up.importId,
    mapping: { textColumn: "response" },
    unitization: { scheme: "response" },
  });
  corpusId = confirmed.corpusId;
}

// =========================================================================

test("brief route: SSE reports sampling → prompt-composed → director-called → tick(s) → validating ahead of para/done", async () => {
  await setup();
  // slow the one Director call past the ~2s tick interval
  mock().setHandler("brief-progress", async (req) => {
    await sleep(2600);
    return briefAnswer(req);
  });

  const { status, events } = await readSse(`/api/projects/${SLUG}/brief`, {
    method: "POST",
    body: { corpusId },
  });
  assert.equal(status, 200);

  const names = events.map((e) => e.event);
  assert.deepEqual(
    names.filter((n) => n !== "tick"),
    ["sampling", "prompt-composed", "director-called", "validating", "para", "para", "done"],
    `stage backbone (got ${names.join(", ")})`,
  );

  // ticks: at least one fired during the slowed call, every one of them
  // strictly between director-called and validating, each with a numeric
  // elapsed (seconds, not a fake percentage)
  const ticks = events.filter((e) => e.event === "tick");
  assert.ok(ticks.length >= 1, `≥1 tick during a ~2.6s call (got ${ticks.length})`);
  for (const t of ticks) {
    assert.equal(
      typeof t.data.elapsed,
      "number",
      `tick carries numeric elapsed (got ${JSON.stringify(t.data)})`,
    );
    assert.ok(Number.isFinite(t.data.elapsed) && t.data.elapsed >= 0);
  }
  const calledAt = names.indexOf("director-called");
  const validatingAt = names.indexOf("validating");
  for (let i = 0; i < names.length; i++) {
    if (names[i] === "tick") {
      assert.ok(
        i > calledAt && i < validatingAt,
        `tick at ${i} sits inside the call window (${calledAt}..${validatingAt})`,
      );
    }
  }

  // payloads state what the server knows
  const sampling = events.find((e) => e.event === "sampling");
  assert.equal(sampling.data.sampleN, UNIT_ROWS, "small corpus → the sample is the whole corpus");
  assert.equal(sampling.data.unitCount, UNIT_ROWS);
  const called = events.find((e) => e.event === "director-called");
  assert.equal(called.data.provider, "mock");
  assert.equal(called.data.model, "mock-1");
  const composed = events.find((e) => e.event === "prompt-composed");
  assert.ok(composed.data.chars > 0, "prompt size is known and stated");
  const validating = events.find((e) => e.event === "validating");
  assert.equal(validating.data.sampleN, UNIT_ROWS);

  // the existing taxonomy is intact
  const done = events.find((e) => e.event === "done");
  assert.match(done.data.briefId, /^brief_/);
  const paras = events.filter((e) => e.event === "para");
  assert.ok(paras.every((p) => typeof p.data.md === "string" && Array.isArray(p.data.refs)));
});

test("a failing Director call clears the ticker — no orphaned interval keeps ticking after the error", async () => {
  // module-level: drive generateBrief directly so the onStage spy can watch
  // for ticks AFTER the rejection (an orphaned setInterval would keep firing)
  mock().setHandler("brief-progress", async () => {
    await sleep(2600); // one tick fires, then the call fails
    throw new Error("provider exploded mid-call");
  });
  const project = await loadProject(SLUG);

  const staged = [];
  await assert.rejects(
    generateBrief(project, corpusId, { onStage: (event, data) => staged.push({ event, data }) }),
    /provider exploded mid-call/,
  );

  const names = staged.map((s) => s.event);
  assert.ok(
    names.includes("director-called"),
    `stages reported up to the failure (got ${names.join(", ")})`,
  );
  assert.ok(!names.includes("validating"), "the failed call never reaches validation");
  const ticksAtFailure = staged.filter((s) => s.event === "tick").length;
  assert.ok(ticksAtFailure >= 1, `≥1 tick before the failure (got ${ticksAtFailure})`);

  await sleep(2500); // a leaked 2s interval would tick at least once more
  const ticksAfterWait = staged.filter((s) => s.event === "tick").length;
  assert.equal(ticksAfterWait, ticksAtFailure, "the ticker stopped when the call settled");
});

test("brief route: a mid-stream failure still arrives as the error event after the progress stages", async () => {
  mock().setHandler("brief-progress", async () => {
    throw new Error("immediate provider failure");
  });
  const { status, events } = await readSse(`/api/projects/${SLUG}/brief`, {
    method: "POST",
    body: { corpusId },
  });
  assert.equal(status, 200, "validation passed — failures inside the stream stay in-stream");
  const names = events.map((e) => e.event);
  assert.deepEqual(
    names.filter((n) => n !== "tick"),
    ["sampling", "prompt-composed", "director-called", "error"],
    `stages then the error (got ${names.join(", ")})`,
  );
  const err = events.find((e) => e.event === "error");
  assert.match(err.data.message, /immediate provider failure/);
});
