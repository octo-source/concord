// Task F (Director half) — orchestration brain tests.
//
// Fully hermetic: every Director interaction is scripted through MockModel
// handlers (mock.setHandler fires when the system message carries
// [[handler:name]]; tests inject the marker via project.director.systemSuffix,
// which production also supports as researcher prompt customization). Where
// the Director modules would call the sibling run engine / stability checker
// (built concurrently), tests inject doubles matching the PINNED interface:
//   engine.runEphemeral(project, instrument, units, opts) → {outputs, cost, quarantine}
//   stability.stabilityCheck(project, instrument, units, {k, n}) → {alpha, pass, runs}
//   outputSchemaFor(construct) → OutputSchema descriptor
// No test depends on sibling files existing.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ConcordError } from "../../server/core/errors.js";
import { createProject, createConstruct, createRun, createAnalysis } from "../../server/core/objects.js";
import { saveProject, loadProject, updateProject, projectDir } from "../../server/core/store.js";
import * as ledger from "../../server/core/ledger.js";
import { newId, unitId } from "../../server/core/ids.js";
import { getAdapter } from "../../server/providers/registry.js";
import { validateSchema } from "../../server/providers/base.js";
import { compile as compileDictionary } from "../../server/instruments/dictionary.js";

import { callDirector, directorCosts } from "../../server/director/director.js";
import * as prompts from "../../server/director/prompts.js";
import { generateBrief } from "../../server/director/brief.js";
import { draftConstructs, importCodebook, inductiveTaxonomy, acceptConstructs } from "../../server/director/constructs.js";
import { compileInstrument, seedDictionary, acceptInstrument } from "../../server/director/compiler.js";
import { silverTune } from "../../server/director/silver.js";
import { recommendPanel } from "../../server/director/panels.js";
import { makeEscalator } from "../../server/director/escalate.js";
import { suggestAnalyses } from "../../server/director/analyst.js";
import { compileQuestion, approvePlan } from "../../server/director/questionbar.js";

// ---------------------------------------------------------------- harness

let tmpRoot;
before(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "concord-director-"));
  process.env.CONCORD_PROJECTS_DIR = tmpRoot;
});
after(async () => {
  delete process.env.CONCORD_PROJECTS_DIR;
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

// One memoized MockAdapter instance shared with the modules under test:
// registry caches per (provider, keysPath, baseUrl), and both this file and
// callDirector use the default keysPath, so setHandler here is visible there.
const mock = getAdapter({ privacyMode: "open" }, "mock").adapter;

let projSeq = 0;
async function makeProject({ privacyMode = "open", director, handler } = {}) {
  const project = createProject({
    name: `Dir Test ${++projSeq}`,
    slug: `dir-test-${projSeq}`,
    privacyMode,
    director: director === undefined
      ? { provider: "mock", model: "mock-director", snapshot: "mock-1" }
      : director,
  });
  if (handler && project.director) project.director.systemSuffix = `[[handler:${handler}]]`;
  await saveProject(project);
  return project;
}

// Writes a corpus (units.ndjson + project.corpora entry). Texts vary in
// length so length terciles are non-degenerate; meta.dept is categorical.
async function makeCorpus(project, { n = 40, depts = ["Sales", "Ops"], textOf } = {}) {
  const corpusId = newId("corp");
  const units = Array.from({ length: n }, (_, i) => {
    const text = textOf
      ? textOf(i)
      : `Unit ${i}: the pay is ${i % 2 ? "fine overall" : "too low for the work"} and my manager ` +
        `${i % 3 ? "listens to the team" : "ignores all feedback"}. ${"More detail. ".repeat(i % 9)}`.trim();
    return {
      id: unitId(corpusId, i, text),
      text,
      meta: { dept: depts[i % depts.length], tenure: 1 + (i % 7) },
      pos: { row: i },
    };
  });
  const dir = path.join(projectDir(project.slug), "corpora", corpusId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "units.ndjson"), units.map((u) => JSON.stringify(u)).join("\n") + "\n", "utf8");
  const fresh = await updateProject(project.slug, (p) => {
    p.corpora.push({ id: corpusId, name: `corpus-${corpusId}`, unitCount: n });
  });
  Object.assign(project, fresh);
  return { corpusId, units };
}

function binaryConstruct(extra = {}) {
  return createConstruct({
    name: "Pay complaint",
    type: "binary",
    definition: "The unit complains about compensation level or fairness.",
    criteria: {
      include: ["explicit mention of low, unfair, or stagnant pay"],
      exclude: ["complaints solely about benefits or perks"],
    },
    edgeCases: ["sarcastic praise of pay counts as a complaint"],
    examples: [
      { text: "The pay is insulting for what we do.", label: "yes", kind: "positive" },
      { text: "Great team, decent salary.", label: "no", kind: "negative" },
    ],
    categories: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
    authoredBy: "director",
    humanTouched: false,
    ...extra,
  });
}

const sampleIdsIn = (text) => [...new Set([...String(text).matchAll(/unit (u_[0-9a-f]{16})/g)].map((m) => m[1]))];
const lastUser = (req) => [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";

// ---------------------------------------------------------------- director.js

test("callDirector: unset director slot → CONFIG_MISSING with a researcher-facing message", async () => {
  const project = await makeProject({ director: null });
  await assert.rejects(
    callDirector(project, {
      messages: [{ role: "user", content: "x" }],
      schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } },
    }),
    (err) => {
      assert.equal(err.code, "CONFIG_MISSING");
      assert.match(err.message, /[Dd]irector/);
      assert.match(err.message, /[Ss]ettings/);
      return true;
    },
  );
});

test("callDirector: strict-mode project with a network director → PRIVACY_BLOCKED propagates", async () => {
  const project = await makeProject({
    privacyMode: "strict",
    director: { provider: "anthropic", model: "claude-opus-4-8", snapshot: "claude-opus-4-8" },
  });
  await assert.rejects(
    callDirector(project, {
      messages: [{ role: "user", content: "x" }],
      schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } },
    }),
    { code: "PRIVACY_BLOCKED" },
  );
});

test("callDirector: schema is mandatory — Director outputs are artifacts", async () => {
  const project = await makeProject({ handler: "noschema" });
  await assert.rejects(
    callDirector(project, { messages: [{ role: "user", content: "x" }] }),
    { code: "VALIDATION" },
  );
});

test("callDirector: appends systemSuffix to the system message and meters per-project cost", async () => {
  const project = await makeProject({ handler: "t-suffix" });
  let seenSystem = null;
  mock.setHandler("t-suffix", (req) => {
    seenSystem = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    return { ok: true };
  });
  const schema = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } };
  const res = await callDirector(project, {
    messages: [{ role: "system", content: "Director preamble." }, { role: "user", content: "hello" }],
    schema,
  });
  assert.deepEqual(res.json, { ok: true });
  assert.ok(seenSystem.includes("Director preamble."), "original system message preserved");
  assert.ok(seenSystem.includes("[[handler:t-suffix]]"), "suffix appended to system message");

  await callDirector(project, { messages: [{ role: "user", content: "again" }], schema });
  const costs = directorCosts(project);
  assert.equal(costs.calls, 2);
  assert.ok(costs.inputTokens > 0 && costs.outputTokens > 0, "token usage metered");
  assert.equal(costs.usd, 0, "mock director costs $0");

  // a different project has an independent meter
  const other = await makeProject({ handler: "t-suffix" });
  assert.equal(directorCosts(other).calls, 0);
});

// ---------------------------------------------------------------- prompts.js

test("prompts: every exported response schema is strict (additionalProperties:false wherever properties exist)", () => {
  const constructs = [
    binaryConstruct(),
    createConstruct({
      name: "Theme", type: "nominal",
      categories: [{ value: "pay", label: "Pay" }, { value: "mgmt", label: "Management" }],
      authoredBy: "director", humanTouched: false,
    }),
    createConstruct({ name: "Tone", type: "continuous", scale: { min: 0, max: 100 }, authoredBy: "director", humanTouched: false }),
    createConstruct({
      name: "Topics", type: "multilabel",
      categories: [{ value: "pay", label: "Pay" }, { value: "growth", label: "Growth" }],
      authoredBy: "director", humanTouched: false,
    }),
  ];
  const schemas = [
    prompts.BRIEF_SCHEMA, prompts.CONSTRUCTS_SCHEMA, prompts.TAXONOMY_SCHEMA,
    prompts.COMPILE_SCHEMA, prompts.REWRITE_SCHEMA, prompts.PANEL_SCHEMA,
    prompts.ANALYST_SCHEMA, prompts.QUESTION_PLAN_SCHEMA, prompts.DICTIONARY_SEED_SCHEMA,
    ...constructs.map((c) => prompts.judgeResponseSchema(c)),
    ...constructs.map((c) => prompts.escalationSchema(c)),
  ];
  let nodes = 0;
  const walk = (node, at) => {
    if (!node || typeof node !== "object") return;
    if (node.properties) {
      nodes++;
      assert.equal(node.additionalProperties, false, `${at} has properties but allows additional ones`);
      for (const key of node.required ?? []) {
        assert.ok(key in node.properties, `${at}.required lists "${key}" which is not a declared property`);
      }
      for (const [k, sub] of Object.entries(node.properties)) walk(sub, `${at}.${k}`);
    }
    if (node.items) walk(node.items, `${at}[]`);
  };
  schemas.forEach((s, i) => walk(s, `schema#${i}`));
  assert.ok(nodes >= 20, `walked only ${nodes} object nodes — schemas suspiciously thin`);
});

test("prompts: judgeResponseSchema is rationale-first and label-constrained by construct type", () => {
  const bin = prompts.judgeResponseSchema(binaryConstruct());
  assert.deepEqual(Object.keys(bin.properties)[0], "rationale", "rationale must come first");
  assert.deepEqual(bin.properties.label.enum, ["yes", "no"]);
  assert.deepEqual(bin.required, ["rationale", "label", "confidence"]);

  const cont = prompts.judgeResponseSchema(
    createConstruct({ name: "Tone", type: "continuous", scale: { min: 0, max: 100 }, authoredBy: "director", humanTouched: false }),
  );
  assert.equal(cont.properties.label.type, "number");
  assert.equal(cont.properties.label.minimum, 0);
  assert.equal(cont.properties.label.maximum, 100);

  const multi = prompts.judgeResponseSchema(
    createConstruct({
      name: "Topics", type: "multilabel",
      categories: [{ value: "pay", label: "Pay" }, { value: "growth", label: "Growth" }],
      authoredBy: "director", humanTouched: false,
    }),
  );
  assert.equal(multi.properties.label.type, "array");
  assert.deepEqual(multi.properties.label.items.enum, ["pay", "growth"]);
});

test("prompts: worker-class compile instructions differ (lean frontier; 2 examples mid; 4 examples + strict JSON small)", () => {
  const c = binaryConstruct();
  const frontier = prompts.compilePrompt(c, "frontier");
  const mid = prompts.compilePrompt(c, "mid");
  const small = prompts.compilePrompt(c, "small");
  for (const p of [frontier, mid, small]) {
    assert.equal(typeof p.system, "string");
    assert.ok(p.user.includes("{{unit}}"), "compile prompt tells the Director about the required template slots");
    assert.ok(p.user.includes(c.definition), "construct definition shown to the Director");
  }
  assert.match(frontier.user, /lean/i);
  assert.match(mid.user, /two worked examples/i);
  assert.match(small.user, /four worked examples/i);
  assert.match(small.user, /ONLY with(?: a single)? JSON/i);
  assert.doesNotMatch(frontier.user, /four worked examples/i);
});

test("prompts: brief prompt demands evidence anchoring and red flags", () => {
  const { system, user } = prompts.briefPrompt({
    projectName: "P", corpusName: "C", unitCount: 1200,
    sample: [{ id: "u_0123456789abcdef", text: "The pay is low.", meta: { dept: "Sales" } }],
    metaSummary: "dept: Sales, Ops",
  });
  assert.match(system, /research assistant/i);
  assert.match(user, /u_0123456789abcdef/);
  assert.match(user, /red flag/i);
  assert.match(user, /unit id/i);
  assert.match(user, /never (cite|invent|fabricate)/i);
});

// ---------------------------------------------------------------- brief.js

test("brief: stratified seeded sample, ref validation, streaming, persistence, ledger", async () => {
  const project = await makeProject({ handler: "t-brief" });
  const { corpusId, units } = await makeCorpus(project, { n: 1200 });
  const byId = new Map(units.map((u) => [u.id, u]));

  const sampledSets = [];
  mock.setHandler("t-brief", (req) => {
    const ids = sampleIdsIn(lastUser(req));
    sampledSets.push(ids);
    return {
      unitOfAnalysis: "one survey response per row",
      paragraphs: [
        { md: "Pay dominates the corpus.", refs: [ids[0], "u_deadbeefdeadbeef", ids[1]] },
        { md: "Management complaints cluster in Ops.", refs: [ids[2]] },
        { md: "Tenure shapes tone.", refs: [ids[3], ids[4]] },
      ],
      themes: [
        { name: "Pay", definition: "Compensation level and fairness.", quoteRefs: [ids[0], ids[5], "u_0000000000000000"] },
        { name: "Management", definition: "Supervisor behavior.", quoteRefs: [ids[2], ids[6], ids[7]] },
      ],
      redFlags: [{ kind: "duplicates", detail: "Several near-identical responses.", refs: [ids[8]] }],
      suggestedQuestions: ["Which departments complain about pay?"],
    };
  });

  const seen = [];
  const brief = await generateBrief(project, corpusId, { onParagraph: (p, i) => seen.push({ i, md: p.md }) });

  // sample: 200–500, stratified, deterministic
  const ids = sampledSets[0];
  assert.equal(ids.length, 200, `sample size ${ids.length}, expected 200 for a 1200-unit corpus`);
  for (const id of ids) assert.ok(byId.has(id), `sampled id ${id} is a real unit`);
  const sampledUnits = ids.map((id) => byId.get(id));
  assert.ok(new Set(sampledUnits.map((u) => u.meta.dept)).size === 2, "sample spans both departments");
  const lens = units.map((u) => u.text.length).sort((a, b) => a - b);
  const [t1, t2] = [lens[Math.floor(lens.length / 3)], lens[Math.floor((2 * lens.length) / 3)]];
  const terciles = new Set(sampledUnits.map((u) => (u.text.length <= t1 ? 0 : u.text.length <= t2 ? 1 : 2)));
  assert.equal(terciles.size, 3, "sample spans all three length terciles");

  // invalid refs dropped + counted
  assert.equal(brief.issues.invalidRefs, 2);
  assert.deepEqual(brief.paragraphs[0].refs, [ids[0], ids[1]]);
  assert.deepEqual(brief.themes[0].quoteRefs, [ids[0], ids[5]]);
  assert.equal(brief.authoredBy, "director");
  assert.equal(brief.humanTouched, false);
  assert.equal(brief.corpusId, corpusId);

  // streamed in order
  assert.deepEqual(seen, [
    { i: 0, md: "Pay dominates the corpus." },
    { i: 1, md: "Management complaints cluster in Ops." },
    { i: 2, md: "Tenure shapes tone." },
  ]);

  // persisted artifact + project meta + ledger
  const file = path.join(projectDir(project.slug), "briefs", `${brief.id}.json`);
  const onDisk = JSON.parse(await readFile(file, "utf8"));
  assert.equal(onDisk.id, brief.id);
  assert.equal(onDisk.authoredBy, "director");
  const fresh = await loadProject(project.slug);
  assert.equal(fresh.briefs.length, 1);
  assert.equal(fresh.briefs[0].id, brief.id);
  const events = await ledger.query(projectDir(project.slug), { type: "brief.generated" });
  assert.equal(events.length, 1);
  assert.equal(events[0].actor, "director");
  assert.equal(events[0].refs.briefId, brief.id);
  assert.equal(events[0].refs.corpusId, corpusId);

  // determinism: a second brief sees the identical sample
  await generateBrief(project, corpusId, {});
  assert.deepEqual(sampledSets[1], sampledSets[0], "stratified sample must be seeded/deterministic");
});

test("brief: unknown corpus → NOT_FOUND", async () => {
  const project = await makeProject({ handler: "t-brief-nf" });
  await assert.rejects(generateBrief(project, "corp_nope", {}), { code: "NOT_FOUND" });
});

test("brief: names the corpus's text column in the prompt and records textColumn + metaColumns on the artifact", async () => {
  const project = await makeProject({ handler: "t-brief-scope" });
  const { corpusId } = await makeCorpus(project, { n: 40 });
  // stamp the provenance import/confirm now records on the corpus entry
  Object.assign(project, await updateProject(project.slug, (p) => {
    const c = p.corpora.find((x) => x.id === corpusId);
    c.textColumn = "abouttxt";
    c.metaColumns = 60;
  }));

  let userSeen = null;
  mock.setHandler("t-brief-scope", (req) => {
    userSeen = lastUser(req);
    return {
      unitOfAnalysis: "one row", paragraphs: [{ md: "p.", refs: [] }],
      themes: [], redFlags: [], suggestedQuestions: [],
    };
  });
  const brief = await generateBrief(project, corpusId, {});
  assert.ok(userSeen.includes("Unit text comes from the column 'abouttxt'"),
    `prompt names the text column (got: ${String(userSeen).slice(0, 200)})`);
  assert.match(userSeen, /60 metadata columns are summarized alongside/);
  assert.equal(brief.textColumn, "abouttxt");
  assert.equal(brief.metaColumns, 60);

  const onDisk = JSON.parse(await readFile(path.join(projectDir(project.slug), "briefs", `${brief.id}.json`), "utf8"));
  assert.equal(onDisk.textColumn, "abouttxt");
  assert.equal(onDisk.metaColumns, 60);
});

test("brief: legacy corpus entry without provenance → no fabricated column name; metaColumns falls back to detection", async () => {
  const project = await makeProject({ handler: "t-brief-legacy" });
  const { corpusId } = await makeCorpus(project, { n: 30 }); // entry has no textColumn/metaColumns
  let userSeen = null;
  mock.setHandler("t-brief-legacy", (req) => {
    userSeen = lastUser(req);
    return {
      unitOfAnalysis: "one row", paragraphs: [{ md: "p.", refs: [] }],
      themes: [], redFlags: [], suggestedQuestions: [],
    };
  });
  const brief = await generateBrief(project, corpusId, {});
  assert.ok(!userSeen.includes("Unit text comes from the column"), "no invented scope sentence");
  assert.equal(brief.textColumn, null);
  assert.equal(brief.metaColumns, 2, "dept + tenure detected from the units themselves");
});

// ---------------------------------------------------------------- constructs.js

test("constructs: draftConstructs returns director-authored proposals with examples mined from the sample", async () => {
  const project = await makeProject({ handler: "t-draft" });
  const sampleUnits = [
    { id: "u_aaaaaaaaaaaaaaa1", text: "The pay is insulting for the hours we put in.", meta: {} },
    { id: "u_aaaaaaaaaaaaaaa2", text: "My manager never listens to the team.", meta: {} },
    { id: "u_aaaaaaaaaaaaaaa3", text: "Honestly the salary was fine, I left for growth.", meta: {} },
  ];
  let promptText = null;
  mock.setHandler("t-draft", (req) => {
    promptText = lastUser(req);
    return {
      constructs: [
        {
          name: "Pay complaint", type: "binary",
          definition: "The unit complains about compensation level or fairness.",
          criteria: { include: ["names pay, salary, or compensation as a problem"], exclude: ["benefits-only complaints"] },
          edgeCases: ["sarcastic praise of pay is a complaint"],
          examples: [
            { text: "The pay is insulting for the hours we put in.", label: "yes", kind: "positive" },
            { text: "Honestly the salary was fine, I left for growth.", label: "no", kind: "nearmiss" },
          ],
          categories: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
        },
        {
          name: "Management complaint", type: "binary",
          definition: "The unit criticizes direct management behavior.",
          criteria: { include: ["criticism of a manager or supervisor"], exclude: ["criticism of company strategy"] },
          edgeCases: [],
          examples: [{ text: "My manager never listens to the team.", label: "yes", kind: "positive" }],
          categories: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
        },
      ],
    };
  });
  const out = await draftConstructs(project, ["pay", "management"], sampleUnits);
  assert.equal(out.length, 2);
  for (const c of out) {
    assert.match(c.id, /^c_/);
    assert.equal(c.authoredBy, "director");
    assert.equal(c.humanTouched, false);
    for (const ex of c.examples) {
      assert.ok(sampleUnits.some((u) => u.text.includes(ex.text)), `worked example "${ex.text}" must be mined from the sample`);
    }
  }
  assert.ok(promptText.includes(sampleUnits[0].text), "sample units shown to the Director");
  assert.match(promptText, /verbatim/i);

  // acceptance persists + ledgers construct.created per construct
  const ids = await acceptConstructs(project, out);
  assert.equal(ids.length, 2);
  const fresh = await loadProject(project.slug);
  assert.deepEqual(fresh.constructs.map((c) => c.id), ids);
  const events = await ledger.query(projectDir(project.slug), { type: "construct.created" });
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.refs.constructId).sort(), [...ids].sort());
});

test("constructs: draftConstructs stamps draftedFrom when a corpus fed the sample; acceptance persists it", async () => {
  const project = await makeProject({ handler: "t-draft-prov" });
  const { corpusId, units } = await makeCorpus(project, { n: 12 });
  mock.setHandler("t-draft-prov", () => ({
    constructs: [{
      name: "Pay complaint", type: "binary",
      definition: "The unit complains about compensation level or fairness.",
      criteria: { include: ["names pay as a problem"], exclude: [] },
      edgeCases: [], examples: [],
      categories: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
    }],
  }));

  // sample drawn from a registered corpus → proposals carry its id
  const out = await draftConstructs(project, ["pay"], units.slice(0, 5));
  assert.equal(out.length, 1);
  assert.equal(out[0].draftedFrom, corpusId, "the proposal names the corpus that fed the sample");

  // ad-hoc units that belong to no registered corpus → no stamp, no guess
  const loose = await draftConstructs(project, ["pay"], [
    { id: "u_ffffffffffffff01", text: "a loose unit from nowhere in particular", meta: {} },
  ]);
  assert.equal(loose[0].draftedFrom, undefined);

  // acceptance persists the provenance onto the project graph
  const ids = await acceptConstructs(project, out);
  const fresh = await loadProject(project.slug);
  assert.equal(fresh.constructs.find((c) => c.id === ids[0]).draftedFrom, corpusId);
});

test("constructs: importCodebook parses a DOCX and structures it via one Director call", async () => {
  const project = await makeProject({ handler: "t-import" });
  const buf = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "ingest-min.docx"));
  let promptText = null;
  mock.setHandler("t-import", (req) => {
    promptText = lastUser(req);
    return {
      constructs: [{
        name: "Imported construct", type: "binary",
        definition: "From the legacy codebook.",
        criteria: { include: ["per legacy rule"], exclude: [] },
        edgeCases: [], examples: [],
        categories: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
      }],
    };
  });
  const out = await importCodebook(project, buf, "docx");
  assert.equal(out.length, 1);
  assert.equal(out[0].authoredBy, "director");
  assert.ok(promptText.includes("First paragraph from DOCX."), "document text reaches the Director");
  await assert.rejects(importCodebook(project, buf, "txt"), { code: "VALIDATION" });
});

test("constructs: inductiveTaxonomy is framed as hypothesis generation with validated quote refs", async () => {
  const project = await makeProject({ handler: "t-induct" });
  const { corpusId } = await makeCorpus(project, { n: 30 });
  mock.setHandler("t-induct", (req) => {
    const ids = sampleIdsIn(lastUser(req));
    return {
      themes: [
        { name: "Pay", definition: "Compensation grievances.", quoteRefs: [ids[0], ids[1], "u_ffffffffffffffff"] },
        { name: "Management", definition: "Supervisor friction.", quoteRefs: [ids[2]] },
      ],
      note: "Hypotheses only.",
    };
  });
  const tax = await inductiveTaxonomy(project, corpusId, { n: 25 });
  assert.equal(tax.mode, "inductive-hypothesis");
  assert.equal(tax.authoredBy, "director");
  assert.equal(tax.humanTouched, false);
  assert.equal(tax.themes.length, 2);
  assert.equal(tax.themes[0].quoteRefs.length, 2, "invalid quote ref dropped");
  assert.equal(tax.issues.invalidRefs, 1);
  assert.equal(tax.sampleN, 25);
});

// ---------------------------------------------------------------- compiler.js

test("compiler: workerClass scaffolding is enforced on the compiled template", async () => {
  const project = await makeProject({ handler: "t-compile" });
  const construct = binaryConstruct();
  const schemaForCalls = [];
  const outputSchemaFor = (c) => {
    schemaForCalls.push(c.id);
    return { type: "binary", options: ["yes", "no"] };
  };
  // Director returns a deliberately under-scaffolded template: no {{unit}}
  // slot, no output constraints. The compiler must guarantee the invariants.
  mock.setHandler("t-compile", () => ({
    promptTemplate: "Judge whether the unit complains about pay.\n{{definition}}\n{{criteria}}",
    note: "lean draft",
  }));

  const small = await compileInstrument(project, construct, {
    workerClass: "small", provider: "mock", model: "mock-1", snapshot: "mock-1", outputSchemaFor,
  });
  assert.equal(small.kind, "judge");
  assert.equal(small.authoredBy, "director");
  assert.equal(small.humanTouched, false);
  assert.equal(small.payload.workerClass, "small");
  assert.equal(small.payload.provider, "mock");
  assert.equal(small.payload.model, "mock-1");
  assert.equal(small.payload.rationaleFirst, true);
  assert.deepEqual(small.payload.schema, { type: "binary", options: ["yes", "no"] });
  assert.deepEqual(schemaForCalls, [construct.id], "outputSchemaFor consulted exactly once");
  for (const slot of ["{{definition}}", "{{criteria}}", "{{examples}}", "{{unit}}"]) {
    assert.ok(small.payload.promptTemplate.includes(slot), `missing slot ${slot} must be appended`);
  }
  assert.match(small.payload.promptTemplate, /Respond ONLY with a single JSON object/);
  assert.match(small.payload.promptTemplate, /No prose/);
  assert.match(small.payload.promptTemplate, /No code fences/);

  const frontier = await compileInstrument(project, construct, {
    workerClass: "frontier", provider: "mock", model: "mock-1", snapshot: "mock-1", outputSchemaFor,
  });
  assert.doesNotMatch(frontier.payload.promptTemplate, /Respond ONLY with a single JSON object/,
    "frontier templates stay lean — no small-class scaffolding");
  assert.ok(frontier.payload.promptTemplate.includes("{{unit}}"));

  await assert.rejects(
    compileInstrument(project, construct, { workerClass: "huge", provider: "mock", model: "mock-1", outputSchemaFor }),
    { code: "VALIDATION" },
  );

  // acceptance persists + ledgers instrument.compiled
  await acceptInstrument(project, small);
  const fresh = await loadProject(project.slug);
  assert.equal(fresh.instruments.length, 1);
  assert.equal(fresh.instruments[0].id, small.id);
  const events = await ledger.query(projectDir(project.slug), { type: "instrument.compiled" });
  assert.equal(events.length, 1);
  assert.equal(events[0].refs.instrumentId, small.id);
  assert.equal(events[0].refs.constructId, construct.id);
});

// June 2026 field bug: reasoning-class workers (Gemini Flash via OpenRouter)
// bill thinking tokens against max_tokens. The old class budgets (frontier
// 512 / mid 384 / small 256) fit the rationale-first JSON alone, so MOST
// judge calls truncated nondeterministically and quarantined. Budgets must
// cover JSON + thinking; the per-call truncation retry covers the tail.
test("compiler: class budgets tolerate reasoning-model thinking tokens (small ≥1024, mid ≥1536, frontier ≥2048)", async () => {
  const project = await makeProject();
  const construct = binaryConstruct();
  const floors = { small: 1024, mid: 1536, frontier: 2048 };
  for (const [workerClass, floor] of Object.entries(floors)) {
    const inst = await compileInstrument(project, construct, {
      workerClass, provider: "mock", model: "mock-1", snapshot: "mock-1",
      promptTemplate: "T {{definition}} {{criteria}} {{examples}} {{unit}}", // escape hatch: no Director call
      outputSchemaFor: () => ({ type: "binary", options: ["yes", "no"] }),
    });
    assert.ok(
      inst.payload.params.maxTokens >= floor,
      `${workerClass} budget ${inst.payload.params.maxTokens} must be ≥ ${floor}: thinking tokens bill against max_tokens`,
    );
  }
});

test("compiler: seedDictionary validates the proposed term list through dictionary.compile and drops invalid terms with a note", async () => {
  const project = await makeProject({ handler: "t-dict" });
  const construct = binaryConstruct({ name: "Pay language" });
  mock.setHandler("t-dict", () => ({
    categories: [
      { name: "pay", terms: ["pay", "salar*", "under*paid", "\"work life balance\"", "wage"] },
      { name: "NOT_ok", terms: ["nope"] },
    ],
    note: "seed list",
  }));
  const { instrument, dropped } = await seedDictionary(project, construct, [
    { id: "u_1", text: "the pay and salary talk" },
  ]);
  assert.equal(instrument.kind, "dictionary");
  assert.equal(instrument.authoredBy, "director");
  const cat = instrument.payload.categories.find((c) => c.name === "pay");
  assert.deepEqual(cat.terms.map((t) => t.term), ["pay", "salar*", "\"work life balance\"", "wage"]);
  assert.ok(dropped.some((d) => d.term === "under*paid" && /\*/.test(d.reason)), "misplaced wildcard dropped with reason");
  assert.ok(dropped.some((d) => d.category === "NOT_ok"), "reserved category name dropped with reason");
  assert.equal(instrument.payload.scoring, "percentOfWords");
  // the surviving payload must compile cleanly
  compileDictionary(instrument.payload);
});

// ---------------------------------------------------------------- silver.js

test("silver: tuning loop plateaus, records the curve, versions per iteration, and stabilizes on pass", async () => {
  const project = await makeProject({ handler: "t-silver" });
  const { units } = await makeCorpus(project, { n: 200 });
  const construct = binaryConstruct();
  Object.assign(project, await updateProject(project.slug, (p) => { p.constructs.push(construct); }));

  let rewrites = 0;
  mock.setHandler("t-silver", (req) => {
    if (req.schema?.properties?.promptTemplate) {
      rewrites++;
      return { promptTemplate: `Revision ${rewrites}. {{definition}} {{criteria}} {{examples}} <unit>{{unit}}</unit>`, note: `tightened rule ${rewrites}` };
    }
    return { rationale: "Pay is named as the problem.", label: "yes", confidence: 0.92 };
  });

  // Researcher-supplied template (the raw escape hatch): no Director compile
  // call, so the t-silver handler only ever sees label + rewrite requests.
  const instrument = await compileInstrument(project, construct, {
    workerClass: "small", provider: "mock", model: "mock-1", snapshot: "mock-1",
    outputSchemaFor: () => ({ type: "binary", options: ["yes", "no"] }),
    promptTemplate: "Initial template. {{definition}} {{criteria}} {{examples}} <unit>{{unit}}</unit>",
  });
  await acceptInstrument(project, instrument);

  const targets = [0.6, 0.75, 0.79, 0.795, 0.99];
  const engineCalls = [];
  const engine = {
    async runEphemeral(p, inst, sampleUnits) {
      engineCalls.push({ versionHash: inst.versionHash, version: inst.version, n: sampleUnits.length });
      const t = targets[Math.min(engineCalls.length - 1, targets.length - 1)];
      const agree = Math.round(sampleUnits.length * t);
      return {
        outputs: sampleUnits.map((u, k) => ({ unitId: u.id, juror: inst.versionHash, label: k < agree ? "yes" : "no", confidence: 0.8 })),
        cost: { actualUSD: 0, inputTokens: 10, outputTokens: 5 },
        quarantine: [],
      };
    },
  };
  const stabilityCalls = [];
  const stability = {
    async stabilityCheck(p, inst, allUnits, { k, n }) {
      stabilityCalls.push({ versionHash: inst.versionHash, k, n });
      return { alpha: 0.91, pass: true, runs: [{}, {}, {}] };
    },
  };

  const iterations = [];
  const { instrument: tuned, curve } = await silverTune(project, instrument, units, {
    engine, stability, onIteration: (it) => iterations.push(it),
  });

  // curve: 4 iterations, exact scripted agreements, plateau at Δ < 0.01
  assert.equal(curve.length, 4, "must stop at iteration 4 (Δagreement 0.005 < 0.01)");
  assert.deepEqual(curve.map((c) => c.agreement), [0.6, 0.75, 0.79, 0.795]);
  assert.equal(rewrites, 3, "no rewrite after the plateau iteration");
  assert.equal(engineCalls.length, 4);
  // each engine call ran the instrument VERSION of that iteration
  assert.deepEqual(engineCalls.map((c) => c.versionHash), curve.map((c) => c.versionHash));
  assert.equal(new Set(curve.map((c) => c.versionHash)).size, 4, "every iteration is a distinct version");
  assert.equal(tuned.versionHash, curve[3].versionHash, "final instrument is the last iteration's version");
  assert.equal(typeof curve[1].note, "string");
  assert.ok(curve[1].note.length > 0, "rewrite note recorded on the next iteration");
  assert.deepEqual(iterations.map((i) => i.agreement), [0.6, 0.75, 0.79, 0.795], "onIteration streamed in order");

  // stability ran on the FINAL version; pass + ≥1 iteration → stabilized
  assert.equal(stabilityCalls.length, 1);
  assert.equal(stabilityCalls[0].versionHash, tuned.versionHash);
  assert.equal(tuned.level, "stabilized");
  assert.equal(tuned.stability.alpha, 0.91);
  assert.equal(tuned.stability.k, 3);
  assert.ok(tuned.stability.ranAt, "stability.ranAt recorded");
  assert.equal(tuned.silver.iterations.length, 4);
  assert.equal(typeof tuned.silver.goldsetId, "string");

  // silver gold set persisted: tier silver, coder director, pi recorded
  const gsFile = path.join(projectDir(project.slug), "gold", `${tuned.silver.goldsetId}.json`);
  const gs = JSON.parse(await readFile(gsFile, "utf8"));
  assert.equal(gs.tier, "silver");
  assert.equal(gs.status, "complete");
  assert.equal(gs.constructId, construct.id);
  assert.equal(gs.sample.length, 200);
  assert.ok(gs.sample.every((s) => s.pi === 1), "pi = 200/200 = 1 for a full-coverage sample");
  assert.equal(gs.coders.length, 1);
  assert.equal(gs.coders[0].coderId, "director");
  assert.equal(Object.keys(gs.coders[0].labels).length, 200);

  // project persistence + ledger
  const fresh = await loadProject(project.slug);
  const inst = fresh.instruments.find((i) => i.id === tuned.id);
  assert.equal(inst.level, "stabilized");
  assert.equal(inst.versionHash, tuned.versionHash);
  assert.ok(fresh.goldsets.some((g) => g.id === tuned.silver.goldsetId && g.tier === "silver"));
  const pdir = projectDir(project.slug);
  for (const type of ["goldset.created", "goldset.completed", "instrument.silver_tuned"]) {
    const ev = await ledger.query(pdir, { type });
    assert.ok(ev.length >= 1, `missing ledger event ${type}`);
  }
  // instrument.stability is the stability MODULE's append (stability.js:113);
  // the double injected here does not ledger, and silverTune must not
  // re-append the event itself (BUG-1: double-counted stability runs).
  assert.equal((await ledger.query(pdir, { type: "instrument.stability" })).length, 0,
    "silverTune must not ledger instrument.stability — the stability module owns that event");
  const tunedEv = (await ledger.query(pdir, { type: "instrument.silver_tuned" }))[0];
  assert.equal(tunedEv.refs.instrumentId, tuned.id);
  assert.equal(tunedEv.refs.goldsetId, tuned.silver.goldsetId);

  // director labeled 200 units + 3 rewrites
  assert.ok(directorCosts(project).calls >= 203, `expected ≥203 director calls, saw ${directorCosts(project).calls}`);
});

test("silver: stability failure leaves the level exploratory; missing engine/stability is a hard error", async () => {
  const project = await makeProject({ handler: "t-silver2" });
  const { units } = await makeCorpus(project, { n: 10 });
  const construct = binaryConstruct();
  Object.assign(project, await updateProject(project.slug, (p) => { p.constructs.push(construct); }));
  mock.setHandler("t-silver2", (req) => {
    if (req.schema?.properties?.promptTemplate) return { promptTemplate: `R {{definition}} {{criteria}} {{examples}} {{unit}} ${Math.random()}`, note: "n" };
    return { rationale: "r", label: "yes", confidence: 0.9 };
  });
  const instrument = await compileInstrument(project, construct, {
    workerClass: "mid", provider: "mock", model: "mock-1", snapshot: "mock-1",
    outputSchemaFor: () => ({ type: "binary", options: ["yes", "no"] }),
    promptTemplate: "T {{definition}} {{criteria}} {{examples}} {{unit}}",
  });
  await acceptInstrument(project, instrument);

  const engine = {
    async runEphemeral(p, inst, sampleUnits) {
      return {
        outputs: sampleUnits.map((u, k) => ({ unitId: u.id, juror: inst.versionHash, label: k < 5 ? "yes" : "no" })),
        cost: { actualUSD: 0 }, quarantine: [],
      };
    },
  };
  const stability = { async stabilityCheck() { return { alpha: 0.41, pass: false, runs: [] }; } };

  const { instrument: tuned, curve } = await silverTune(project, instrument, units, { engine, stability });
  assert.equal(curve.length, 2, "identical agreement on iteration 2 → plateau");
  assert.equal(tuned.level, "exploratory", "failed stability must not stabilize");
  assert.equal(tuned.stability.alpha, 0.41, "the check's alpha is still recorded (contract shape: {alpha, k, n, ranAt})");
  // The verdict's ledger append belongs to the stability module (asserted
  // against the REAL module in runs.test.js); the double here does not
  // ledger and silverTune must not re-append the event (BUG-1).
  const stEvents = await ledger.query(projectDir(project.slug), { type: "instrument.stability" });
  assert.equal(stEvents.length, 0, "silverTune does not re-ledger the stability verdict — the stability module owns that event");

  await assert.rejects(silverTune(project, instrument, units, { stability }), { code: "VALIDATION" });
  await assert.rejects(silverTune(project, instrument, units, { engine }), { code: "VALIDATION" });
});

// June 2026 field failure, Director side: the worker budgets were raised for
// reasoning-class models, but the DIRECTOR's own calls still carried tiny
// hardcoded budgets — the researcher's silver-tune died TRUNCATED inside the
// per-unit labeling call (512, doubled once to 1024, still starved) while the
// error pointed him at a maxTokens he could not find. Director budgets must
// be reasoning-tolerant, and any failure must NAME the stage that threw.

// shared scaffolding for the silver budget/stage tests: researcher-supplied
// template (no Director compile call), trivial engine + stability doubles
async function silverFixture({ handler, n = 8, targets = [0.5, 0.8, 0.805] }) {
  const project = await makeProject({ handler });
  const { units } = await makeCorpus(project, { n });
  const construct = binaryConstruct();
  Object.assign(project, await updateProject(project.slug, (p) => { p.constructs.push(construct); }));
  const instrument = await compileInstrument(project, construct, {
    workerClass: "mid", provider: "mock", model: "mock-1", snapshot: "mock-1",
    outputSchemaFor: () => ({ type: "binary", options: ["yes", "no"] }),
    promptTemplate: "T {{definition}} {{criteria}} {{examples}} {{unit}}",
  });
  await acceptInstrument(project, instrument);
  let call = 0;
  const engine = {
    async runEphemeral(p, inst, sampleUnits) {
      const t = targets[Math.min(call++, targets.length - 1)];
      const agree = Math.round(sampleUnits.length * t);
      return {
        outputs: sampleUnits.map((u, k) => ({ unitId: u.id, juror: inst.versionHash, label: k < agree ? "yes" : "no" })),
        cost: { actualUSD: 0 },
        quarantine: [],
      };
    },
  };
  const stability = { async stabilityCheck() { return { alpha: 0.9, pass: true, runs: [] }; } };
  return { project, units, instrument, engine, stability };
}

test("silver: Director budgets are reasoning-tolerant — labeling ≥1536, rewrite ≥2048 (thinking tokens bill against max_tokens)", async () => {
  const budgets = { label: [], rewrite: [] };
  mock.setHandler("t-silver-budget", (req) => {
    if (req.schema?.properties?.promptTemplate) {
      budgets.rewrite.push(req.maxTokens);
      return { promptTemplate: `R${budgets.rewrite.length} {{definition}} {{criteria}} {{examples}} {{unit}}`, note: "n" };
    }
    budgets.label.push(req.maxTokens);
    return { rationale: "r", label: "yes", confidence: 0.9 };
  });
  const { project, units, instrument, engine, stability } = await silverFixture({ handler: "t-silver-budget" });
  await silverTune(project, instrument, units, { engine, stability });
  assert.ok(budgets.label.length >= 8, `labeling calls observed (got ${budgets.label.length})`);
  for (const b of budgets.label) {
    assert.ok(b >= 1536, `per-unit silver labeling budget ${b} must be ≥1536 — reasoning Directors bill thinking tokens against max_tokens`);
  }
  assert.ok(budgets.rewrite.length >= 1, "at least one rewrite call observed");
  for (const b of budgets.rewrite) {
    assert.ok(b >= 2048, `prompt-rewrite budget ${b} must be ≥2048 — reasoning Directors bill thinking tokens against max_tokens`);
  }
});

test("silver: a TRUNCATED labeling call escapes stage-named — 'Director silver-labeling:' prefix, code + details + original message preserved", async () => {
  mock.setHandler("t-silver-trunc", (req) => {
    if (req.schema?.properties?.promptTemplate) return { promptTemplate: "R {{definition}} {{criteria}} {{examples}} {{unit}}", note: "n" };
    throw new ConcordError("TRUNCATED", `structured output truncated at the token limit; raise maxTokens (currently ${req.maxTokens}) and retry`, { finishReason: "length" });
  });
  const { project, units, instrument, engine, stability } = await silverFixture({ handler: "t-silver-trunc", n: 4 });
  await assert.rejects(silverTune(project, instrument, units, { engine, stability }), (err) => {
    assert.equal(err.code, "TRUNCATED", "code preserved through the stage label");
    assert.match(err.message, /^Director silver-labeling: /, "the failing Director stage is named");
    assert.match(err.message, /truncated at the token limit/, "original message preserved after the prefix");
    assert.equal(err.details.finishReason, "length", "details preserved");
    return true;
  });
});

test("silver: a rewrite failure escapes stage-named — 'Director prompt-rewrite:' prefix, code preserved", async () => {
  mock.setHandler("t-silver-rw-trunc", (req) => {
    if (req.schema?.properties?.promptTemplate) {
      throw new ConcordError("TRUNCATED", `structured output truncated at the token limit; raise maxTokens (currently ${req.maxTokens}) and retry`, { finishReason: "length" });
    }
    return { rationale: "r", label: "yes", confidence: 0.9 };
  });
  const { project, units, instrument, engine, stability } = await silverFixture({ handler: "t-silver-rw-trunc", n: 4 });
  await assert.rejects(silverTune(project, instrument, units, { engine, stability }), (err) => {
    assert.equal(err.code, "TRUNCATED");
    assert.match(err.message, /^Director prompt-rewrite: /, "the failing Director stage is named");
    assert.match(err.message, /truncated at the token limit/, "original message preserved after the prefix");
    return true;
  });
});

// ---------------------------------------------------------------- panels.js

test("panels: recommends a family-disjoint panel from registry catalogs", async () => {
  const project = await makeProject({ handler: "t-panel" });
  const construct = binaryConstruct();
  // Hermetic catalogs: the network-backed ones are patched on the memoized instances.
  getAdapter(project, "openrouter").adapter.catalog = async () => [];
  getAdapter(project, "ollama").adapter.catalog = async () => [];

  let candidatesShown = null;
  mock.setHandler("t-panel", (req) => {
    candidatesShown = lastUser(req);
    return {
      jurors: [
        { provider: "anthropic", model: "claude-haiku-4-5", workerClass: "mid" },
        { provider: "openai", model: "gpt-5.2-mini", workerClass: "mid" },
        { provider: "mock", model: "mock-1", workerClass: "small" },
      ],
      aggregation: "majority",
      rationale: "Three cheap, family-disjoint judges; majority vote handles binary well.",
    };
  });

  const rec = await recommendPanel(project, construct, {
    budgetUSDper1k: 2, outputSchemaFor: () => ({ type: "binary", options: ["yes", "no"] }),
  });
  assert.equal(rec.authoredBy, "director");
  assert.equal(rec.humanTouched, false);
  assert.equal(rec.payload.aggregation, "majority");
  assert.equal(rec.payload.jurors.length, 3);
  assert.ok(rec.rationale.length > 0);
  for (const j of rec.payload.jurors) {
    assert.equal(typeof j.promptTemplate, "string");
    assert.ok(j.promptTemplate.includes("{{unit}}"));
    assert.deepEqual(j.schema, { type: "binary", options: ["yes", "no"] });
    assert.equal(j.params.temperature, 0);
    assert.ok(j.snapshot, "snapshot resolved from the catalog");
  }
  assert.equal(new Set(rec.families).size, rec.payload.jurors.length, `families must be disjoint: ${rec.families}`);
  assert.ok(candidatesShown.includes("claude-haiku-4-5"), "catalog candidates shown to the Director");

  // overlapping families → VALIDATION
  mock.setHandler("t-panel", () => ({
    jurors: [
      { provider: "anthropic", model: "claude-haiku-4-5", workerClass: "mid" },
      { provider: "anthropic", model: "claude-sonnet-4-6", workerClass: "mid" },
      { provider: "mock", model: "mock-1", workerClass: "small" },
    ],
    aggregation: "majority",
    rationale: "bad",
  }));
  await assert.rejects(
    recommendPanel(project, construct, { outputSchemaFor: () => ({ type: "binary", options: ["yes", "no"] }) }),
    (err) => err.code === "VALIDATION" && /disjoint/i.test(err.message),
  );
});

test("panels: strict mode offers only local candidates to the Director", async () => {
  const project = await makeProject({ privacyMode: "strict", handler: "t-panel-strict" });
  const construct = binaryConstruct();
  getAdapter(project, "ollama").adapter.catalog = async () => [
    { id: "llama3.2:3b", name: "llama3.2:3b", family: "llama", ctx: null, pricing: { inUSDper1M: 0, outUSDper1M: 0 }, snapshot: "sha-l" },
    { id: "qwen2.5:7b", name: "qwen2.5:7b", family: "qwen", ctx: null, pricing: { inUSDper1M: 0, outUSDper1M: 0 }, snapshot: "sha-q" },
  ];
  let candidatesShown = null;
  mock.setHandler("t-panel-strict", (req) => {
    candidatesShown = lastUser(req);
    return {
      jurors: [
        { provider: "ollama", model: "llama3.2:3b", workerClass: "small" },
        { provider: "ollama", model: "qwen2.5:7b", workerClass: "small" },
        { provider: "mock", model: "mock-1", workerClass: "small" },
      ],
      aggregation: "unanimityOrFlag",
      rationale: "All-local panel for strict mode.",
    };
  });
  const rec = await recommendPanel(project, construct, {
    outputSchemaFor: () => ({ type: "binary", options: ["yes", "no"] }),
  });
  assert.ok(!/anthropic|claude|gpt-5/i.test(candidatesShown), "no network models offered under strict mode");
  assert.deepEqual(rec.payload.jurors.map((j) => j.provider).sort(), ["mock", "ollama", "ollama"]);
  assert.equal(new Set(rec.families).size, 3, "local families still disjoint");
});

// Same June 2026 field bug as the compiler floor test above, panel edition:
// recommendPanel builds REAL juror payloads, so juror budgets must tolerate
// reasoning-model thinking tokens too. The budgets must be the compiler's
// exported CLASS_MAX_TOKENS — a private copy in panels.js is how the bug
// shipped (compiler raised, panels stale, Gemini Flash jurors truncated and
// quarantined silently).
test("panels: juror budgets are compiler's CLASS_MAX_TOKENS (small ≥1024, mid ≥1536, frontier ≥2048)", async () => {
  const compiler = await import("../../server/director/compiler.js");
  const canonical = compiler.CLASS_MAX_TOKENS;
  assert.ok(canonical, "compiler.js must export CLASS_MAX_TOKENS — the single source juror budgets import");
  const floors = { small: 1024, mid: 1536, frontier: 2048 };
  for (const [workerClass, floor] of Object.entries(floors)) {
    assert.ok(
      canonical[workerClass] >= floor,
      `canonical ${workerClass} budget ${canonical[workerClass]} must be ≥ ${floor}: thinking tokens bill against max_tokens`,
    );
  }

  const project = await makeProject({ handler: "t-panel-budget" });
  const construct = binaryConstruct();
  getAdapter(project, "openrouter").adapter.catalog = async () => [];
  getAdapter(project, "ollama").adapter.catalog = async () => [];
  mock.setHandler("t-panel-budget", () => ({
    jurors: [
      { provider: "anthropic", model: "claude-sonnet-4-6", workerClass: "frontier" },
      { provider: "openai", model: "gpt-5.2-mini", workerClass: "mid" },
      { provider: "mock", model: "mock-1", workerClass: "small" },
    ],
    aggregation: "majority",
    rationale: "one juror per worker class so every budget is pinned",
  }));
  const rec = await recommendPanel(project, construct, {
    outputSchemaFor: () => ({ type: "binary", options: ["yes", "no"] }),
  });
  assert.equal(rec.payload.jurors.length, 3);
  for (const j of rec.payload.jurors) {
    assert.equal(
      j.params.maxTokens, canonical[j.workerClass],
      `${j.workerClass} juror budget must be the canonical CLASS_MAX_TOKENS.${j.workerClass}, not a stale private copy`,
    );
    assert.ok(
      j.params.maxTokens >= floors[j.workerClass],
      `${j.workerClass} juror budget ${j.params.maxTokens} must be ≥ ${floors[j.workerClass]}: thinking tokens bill against max_tokens`,
    );
  }
});

// ---------------------------------------------------------------- escalate.js

test("escalate: Director disagreement produces a marked replacement with a one-line reason; agreement returns null", async () => {
  const project = await makeProject({ handler: "t-esc" });
  const construct = binaryConstruct();
  let promptSeen = null;
  mock.setHandler("t-esc", (req) => {
    promptSeen = lastUser(req);
    return {
      rationale: "The unit explicitly says pay was fine; the complaint is about hours.",
      label: "no",
      confidence: 0.93,
      reason: "Worker over-weighted the word 'pay' despite the explicit denial.",
    };
  });
  const escalate = makeEscalator(project, construct);
  const unit = { id: "u_e1e1e1e1e1e1e1e1", text: "Pay was fine honestly — the hours were the problem.", meta: {} };
  const workerOutput = { unitId: unit.id, juror: "vh_worker", label: "yes", confidence: 0.41, rationale: "mentions pay" };

  const replacement = await escalate(unit, workerOutput);
  assert.ok(replacement, "disagreement must produce a replacement");
  assert.equal(replacement.unitId, unit.id);
  assert.equal(replacement.juror, "director");
  assert.equal(replacement.escalatedBy, "director",
    "the replacement carries structural provenance — the engine copies escalatedBy onto the written line while keeping the worker's juror hash");
  assert.equal(replacement.label, "no");
  assert.equal(replacement.escalated, true);
  assert.match(replacement.rationale, /Worker over-weighted/);
  assert.ok(promptSeen.includes(workerOutput.rationale), "worker rationale shown to the Director");
  assert.ok(promptSeen.includes("yes"), "worker label shown to the Director");
  assert.ok(promptSeen.includes(unit.text), "unit text shown to the Director");

  mock.setHandler("t-esc", () => ({ rationale: "Agree with the worker.", label: "yes", confidence: 0.9, reason: "" }));
  assert.equal(await escalate(unit, workerOutput), null, "agreement → no replacement");
});

test("escalate: second opinion carries maxTokens ≥1536; a failure escapes stage-named — 'Director second opinion:' prefix, code + details preserved", async () => {
  const project = await makeProject({ handler: "t-esc-budget" });
  const construct = binaryConstruct();
  const unit = { id: "u_e2e2e2e2e2e2e2e2", text: "Pay was fine honestly — the hours were the problem.", meta: {} };
  const workerOutput = { unitId: unit.id, juror: "vh_worker", label: "yes", confidence: 0.41, rationale: "mentions pay" };

  // budget: reasoning Directors bill thinking tokens against max_tokens —
  // 512 (doubled once to 1024 by the truncation retry) starved them in the field
  const budgets = [];
  mock.setHandler("t-esc-budget", (req) => {
    budgets.push(req.maxTokens);
    return { rationale: "Agree.", label: "yes", confidence: 0.9, reason: "" };
  });
  const escalate = makeEscalator(project, construct);
  assert.equal(await escalate(unit, workerOutput), null);
  assert.equal(budgets.length, 1);
  assert.ok(budgets[0] >= 1536, `second-opinion budget ${budgets[0]} must be ≥1536`);

  // stage label: the researcher must know WHICH Director call failed
  mock.setHandler("t-esc-budget", (req) => {
    throw new ConcordError("TRUNCATED", `structured output truncated at the token limit; raise maxTokens (currently ${req.maxTokens}) and retry`, { finishReason: "length" });
  });
  await assert.rejects(escalate(unit, workerOutput), (err) => {
    assert.equal(err.code, "TRUNCATED", "code preserved through the stage label");
    assert.match(err.message, /^Director second opinion: /, "the failing Director stage is named");
    assert.match(err.message, /truncated at the token limit/, "original message preserved after the prefix");
    assert.equal(err.details.finishReason, "length", "details preserved");
    return true;
  });
});

// ---------------------------------------------------------------- analyst.js

test("analyst: suggestions are dismissible artifacts whose specs satisfy objects.createAnalysis", async () => {
  const project = await makeProject({ handler: "t-analyst" });
  const { corpusId, units } = await makeCorpus(project, { n: 30 });
  const construct = binaryConstruct();
  const instrument = await compileInstrument(project, construct, {
    workerClass: "small", provider: "mock", model: "mock-1", snapshot: "mock-1",
    outputSchemaFor: () => ({ type: "binary", options: ["yes", "no"] }),
    promptTemplate: "T {{definition}} {{criteria}} {{examples}} {{unit}}",
  });
  await updateProject(project.slug, (p) => { p.constructs.push(construct); p.instruments.push(instrument); });
  Object.assign(project, await loadProject(project.slug));

  const run = createRun({
    instrumentId: instrument.id, versionHash: instrument.versionHash, corpusId,
    provider: "mock", model: "mock-1", status: "complete",
  });
  const outputsSample = units.slice(0, 20).map((u, i) => ({ unitId: u.id, juror: instrument.versionHash, label: i % 3 ? "no" : "yes" }));

  mock.setHandler("t-analyst", (req) => {
    const ids = sampleIdsIn(lastUser(req));
    return {
      suggestions: [
        {
          kind: "crosstab",
          spec: { rowKey: "label", colKey: "dept", instrumentId: instrument.id, corpusId },
          annotation: "Pay complaints look concentrated in Sales.",
          evidenceRefs: [ids[0] ?? outputsSample[0].unitId, "u_bogusbogusbogus1"],
        },
        {
          kind: "descriptive",
          spec: { of: "label", instrumentId: instrument.id, corpusId },
          annotation: "Overall prevalence of pay complaints.",
          evidenceRefs: [],
        },
      ],
    };
  });

  const suggestions = await suggestAnalyses(project, run, outputsSample);
  assert.equal(suggestions.length, 2);
  for (const s of suggestions) {
    const analysis = createAnalysis({ kind: s.kind, spec: s.spec });
    assert.equal(analysis.kind, s.kind);
    assert.equal(typeof s.annotation, "string");
  }
  const sampleIds = new Set(outputsSample.map((o) => o.unitId));
  for (const s of suggestions) {
    for (const ref of s.evidenceRefs) assert.ok(sampleIds.has(ref), `evidence ref ${ref} must come from the outputs sample`);
  }
  assert.equal(suggestions[0].evidenceRefs.length, 1, "bogus evidence ref dropped");
});

// ---------------------------------------------------------------- questionbar.js

test("questionbar: compileQuestion produces a persisted plan; approvePlan materializes constructs + instruments with ledger events", async () => {
  const project = await makeProject({ handler: "t-qbar" });
  const { corpusId, units } = await makeCorpus(project, { n: 40 });

  mock.setHandler("t-qbar", (req) => {
    if (req.schema?.properties?.promptTemplate) {
      return { promptTemplate: "Compiled judge. {{definition}} {{criteria}} {{examples}} <unit>{{unit}}</unit>", note: "compiled" };
    }
    const sampleText = units[0].text;
    return {
      constructs: [{
        name: "Pay complaint", type: "binary",
        definition: "The unit complains about compensation.",
        criteria: { include: ["names pay as a problem"], exclude: ["benefits-only"] },
        edgeCases: [],
        examples: [{ text: sampleText, label: "yes", kind: "positive" }],
        categories: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
      }],
      instruments: [{ construct: "Pay complaint", workerClass: "small", provider: "mock", model: "mock-1", snapshot: "mock-1" }],
      analysis: {
        kind: "crosstab",
        spec: { rowKey: "label", colKey: "dept", corpusId },
        annotation: "Pay complaints by department.",
      },
    };
  });

  const plan = await compileQuestion(project, corpusId, "Which departments complain about pay?");
  assert.match(plan.planId, /^plan_/);
  assert.equal(plan.question, "Which departments complain about pay?");
  assert.equal(plan.authoredBy, "director");
  assert.equal(plan.humanTouched, false);
  assert.equal(plan.status, "proposed");
  assert.equal(plan.constructs.length, 1);
  assert.match(plan.constructs[0].id, /^c_/);
  assert.equal(plan.instruments.length, 1);
  assert.equal(plan.instruments[0].constructId, plan.constructs[0].id);
  assert.equal(plan.instruments[0].workerClass, "small");
  assert.equal(typeof plan.estimate.usd, "number");
  assert.ok(plan.estimate.usd >= 0);
  assert.ok(plan.estimate.etaMin > 0, "eta present");
  assert.equal(plan.estimate.calls, 40, "estimate covers every corpus unit");
  // estimateRun outputTokens = calls × maxTokens: the plan must budget the
  // canonical small-class floor (≥1024 — thinking tokens bill against
  // max_tokens), not the pre-June-2026 256 that understated cost ~4x.
  assert.ok(plan.estimate.outputTokens >= 40 * 1024,
    `plan estimate must use the canonical small-class budget (≥1024/call); got ${plan.estimate.outputTokens} output tokens for 40 calls`);
  assert.equal(plan.analysis.kind, "crosstab");
  createAnalysis({ kind: plan.analysis.kind, spec: plan.analysis.spec }); // spec is materializable

  // plan persists on the project
  let fresh = await loadProject(project.slug);
  assert.equal(fresh.plans.length, 1);
  assert.equal(fresh.plans[0].planId, plan.planId);
  const pdir = projectDir(project.slug);
  assert.equal((await ledger.query(pdir, { type: "plan.compiled" })).length, 1);

  // approval materializes
  const approved = await approvePlan(project, plan.planId, {
    outputSchemaFor: () => ({ type: "binary", options: ["yes", "no"] }),
  });
  assert.deepEqual(approved.constructIds, [plan.constructs[0].id]);
  assert.equal(approved.instrumentIds.length, 1);

  fresh = await loadProject(project.slug);
  assert.equal(fresh.plans[0].status, "approved");
  assert.ok(fresh.constructs.some((c) => c.id === approved.constructIds[0]));
  const inst = fresh.instruments.find((i) => i.id === approved.instrumentIds[0]);
  assert.ok(inst, "instrument materialized");
  assert.equal(inst.kind, "judge");
  assert.equal(inst.constructId, plan.constructs[0].id);
  assert.equal(inst.payload.workerClass, "small");
  assert.match(inst.payload.promptTemplate, /Respond ONLY with a single JSON object/, "small-class scaffolding enforced at approval");
  assert.equal((await ledger.query(pdir, { type: "construct.created" })).length, 1);
  assert.equal((await ledger.query(pdir, { type: "instrument.compiled" })).length, 1);
  assert.equal((await ledger.query(pdir, { type: "plan.approved" })).length, 1);

  await assert.rejects(approvePlan(project, "plan_nope", {}), { code: "NOT_FOUND" });
  // double-approval is refused
  await assert.rejects(approvePlan(project, plan.planId, { outputSchemaFor: () => ({ type: "binary" }) }), { code: "VALIDATION" });
});

test("questionbar: unknown corpus → NOT_FOUND", async () => {
  const project = await makeProject({ handler: "t-qbar2" });
  await assert.rejects(compileQuestion(project, "corp_missing", "anything?"), { code: "NOT_FOUND" });
});

// ---------------------------------------------------------------- error type hygiene

test("ConcordError is used for director-facing failures", async () => {
  const project = await makeProject({ director: null });
  try {
    await callDirector(project, { messages: [], schema: { type: "object", properties: {}, additionalProperties: false } });
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof ConcordError);
  }
});

// ---------------------------------------------------------------- truncation retry (June 2026 field bug)

// A real Director (Gemini Flash via OpenRouter) truncated the brief JSON at
// maxTokens 4096 and the product hard-failed. Director calls now retry ONCE
// at a doubled budget (capped) before giving up.
test("withTruncationRetry: TRUNCATED retries once at doubled budget; cap honored; other errors propagate", async () => {
  const { withTruncationRetry } = await import("../../server/director/director.js");

  const calls = [];
  const r = await withTruncationRetry(async (mt) => {
    calls.push(mt);
    if (calls.length === 1) throw new ConcordError("TRUNCATED", "structured output truncated");
    return { ok: mt };
  }, { maxTokens: 4096 });
  assert.deepEqual(calls, [4096, 8192], "second attempt doubles the budget");
  assert.equal(r.ok, 8192);

  const calls2 = [];
  await withTruncationRetry(async (mt) => {
    calls2.push(mt);
    if (calls2.length === 1) throw new ConcordError("TRUNCATED", "x");
    return {};
  }, { maxTokens: 20000 });
  assert.deepEqual(calls2, [20000, 32768], "doubled budget is capped at 32768");

  await assert.rejects(
    () => withTruncationRetry(async () => { throw new ConcordError("TRUNCATED", "still truncated"); }, { maxTokens: 1024 }),
    (e) => e.code === "TRUNCATED",
    "a second truncation propagates",
  );

  const calls3 = [];
  await assert.rejects(
    () => withTruncationRetry(async (mt) => { calls3.push(mt); throw new ConcordError("PROVIDER_HTTP", "boom"); }, { maxTokens: 4096 }),
    (e) => e.code === "PROVIDER_HTTP",
  );
  assert.equal(calls3.length, 1, "non-truncation errors never retry");

  const calls4 = [];
  await assert.rejects(
    () => withTruncationRetry(async (mt) => { calls4.push(mt); throw new ConcordError("TRUNCATED", "at cap already"); }, { maxTokens: 32768 }),
    (e) => e.code === "TRUNCATED",
  );
  assert.equal(calls4.length, 1, "already at the cap: nothing larger to try");
});

test("generateBrief asks for a realistic token budget (>= 16384)", async () => {
  const project = await makeProject({ handler: "t-budget" });
  const { corpusId } = await makeCorpus(project, { n: 40 });
  const seen = { maxTokens: null };
  mock.setHandler("t-budget", (req) => {
    seen.maxTokens = req.maxTokens;
    return {
      paragraphs: [{ md: "One paragraph.", refs: [] }],
      themes: [], redFlags: [], suggestedQuestions: [], unitOfAnalysis: "response",
    };
  });
  await generateBrief(project, corpusId, {});
  assert.ok(seen.maxTokens >= 16384,
    `brief budget must survive real frontier verbosity (got ${seen.maxTokens}; 4096 truncated in the field)`);
});
