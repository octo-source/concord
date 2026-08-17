// Fixtures mode — the acceptance artifact for the screens wave. When enabled
// (`?fixtures=1` in the hash query, or localStorage.concordFixtures === "1"),
// every api.js namespace is patched in place to resolve from app/fixtures/*.json
// instead of the network. SSE wrappers replay arrays with small delays so the
// Brief streams, the run monitor ticks, and silver-tuning iterates exactly as
// they would against the live server. Mutations (labels, edits, adjudications,
// new projects) write to an in-memory copy so flows feel real for a session.
//
// EVERY response mirrors the LIVE route shape — the fixtures are the same
// contract the screens are tested against in tests/e2e/shapes.test.js.
//
//   import { fixturesEnabled, installFixtures } from "./fixtures.js";
//   if (fixturesEnabled()) await installFixtures();   // before router start
//
// Nothing here runs (or weighs anything) when fixtures mode is off.

import * as apiNs from "./api.js";

const FILES = [
  "project", "units", "import", "instantread", "brief", "constructs",
  "instruments", "goldsets", "runs", "analyses", "plan", "settings",
  "catalog", "evidence", "reports", "columns", "reliability",
];

let db = null; // in-memory clone of all fixture JSON, mutable for the session

/* ---- flag ------------------------------------------------------------------ */

export function fixturesEnabled() {
  try {
    // The Concord server only ever runs on localhost. Any other host is a
    // static deployment (e.g. the Netlify demo) — there is no API to call,
    // so fixtures mode is always on there.
    const host = location.hostname;
    if (host && host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") return true;
    const q = String(location.hash).split("?")[1] ?? "";
    if (/(^|&)fixtures=1(&|$)/.test(q)) {
      localStorage.setItem("concordFixtures", "1");
      return true;
    }
    if (/(^|&)fixtures=0(&|$)/.test(q)) {
      localStorage.removeItem("concordFixtures");
      return false;
    }
    return localStorage.getItem("concordFixtures") === "1";
  } catch {
    return false;
  }
}

export function setFixtures(on) {
  try {
    if (on) localStorage.setItem("concordFixtures", "1");
    else localStorage.removeItem("concordFixtures");
  } catch { /* storage unavailable */ }
}

export function isInstalled() {
  return db !== null;
}

/* ---- helpers ---------------------------------------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

function notFound(what) {
  const err = new apiNs.ApiError("NOT_FOUND", `${what} not found in fixtures`, { status: 404 });
  return Promise.reject(err);
}

let idCounter = 0;
function newId(prefix) {
  idCounter += 1;
  return `${prefix}_fx${Date.now().toString(36)}${idCounter.toString(36)}`;
}

/** Replay [{event, data}] through SSE-style handlers; returns {close}. */
function replaySse(steps, { onStep, onDone, gap = 350, jitter = 250 } = {}) {
  let closed = false;
  (async () => {
    for (const step of steps) {
      await sleep(gap + Math.random() * jitter);
      if (closed) return;
      onStep?.(step);
    }
    await sleep(gap);
    if (!closed) onDone?.();
  })();
  return { close() { closed = true; } };
}

function unitById(id) {
  return db.units.units.find((u) => u.id === id) ?? null;
}

// metaOf — the live goldset summary the project graph carries (goldsets.js).
function goldsetMeta(gs) {
  return {
    id: gs.id,
    constructId: gs.constructId,
    tier: gs.tier,
    design: gs.design,
    status: gs.status,
    n: gs.sample?.length ?? 0,
    coders: (gs.coders ?? []).map((c) => c.coderId),
    ...(gs.corpusId ? { corpusId: gs.corpusId } : {}),
    ...(gs.humanAgreement ? { humanAgreement: { percent: gs.humanAgreement.percent, kappa: gs.humanAgreement.kappa, alpha: gs.humanAgreement.alpha, n: gs.humanAgreement.n } } : {}),
    createdAt: gs.createdAt,
  };
}

// The full project graph the app sees — composed exactly like the live
// project.json: full constructs/instruments/run records, goldset metas,
// analysis summaries. Reflects in-session mutations.
function projectGraph() {
  const p = clone(db.project);
  p.constructs = clone(db.constructs.constructs);
  p.instruments = clone(db.instruments.instruments);
  p.goldsets = db.goldsets.goldsets.map((g) => goldsetMeta(clone(g)));
  p.runs = clone(db.runs.runs);
  return p;
}

// adjudicator-excluded units — permanently out of gold (array or map shape)
function goldsetExcludes(gs, unitId) {
  const ex = gs?.excluded;
  if (Array.isArray(ex)) return ex.includes(unitId);
  return Boolean(ex && typeof ex === "object" && ex[unitId]);
}

function coderUncodable(c, unitId) {
  const u = c?.uncodable;
  if (Array.isArray(u)) return u.includes(unitId);
  return Boolean(u && typeof u === "object" && u[unitId]);
}

// live "adjudicated-or-consensus" gold map (routes/_shared.js goldLabelMap).
// Excluded units never join; a unit any coder marked uncodable waits for the
// adjudicator instead of riding the remaining labels to consensus.
function goldLabelMap(gs) {
  const out = new Map();
  const coders = (gs.coders ?? []).filter((c) =>
    (c.labels && Object.keys(c.labels).length > 0) || c.uncodable?.length || (c.uncodable && typeof c.uncodable === "object"));
  for (const s of gs.sample ?? []) {
    if (goldsetExcludes(gs, s.unitId)) continue;
    const adj = gs.adjudicated?.[s.unitId];
    if (adj !== undefined) {
      out.set(s.unitId, adj);
      continue;
    }
    if (coders.some((c) => coderUncodable(c, s.unitId))) continue;
    const votes = coders.map((c) => c.labels?.[s.unitId]).filter((v) => v !== undefined);
    if (votes.length < 2) continue; // consensus needs ≥2 agreeing coders (live rule)
    const first = JSON.stringify(votes[0]);
    if (votes.every((v) => JSON.stringify(v) === first)) out.set(s.unitId, votes[0]);
  }
  return out;
}

/* ---- install ----------------------------------------------------------------- */

export async function installFixtures() {
  if (db) return db;
  const loaded = {};
  await Promise.all(FILES.map(async (name) => {
    const res = await fetch(`fixtures/${name}.json`);
    if (!res.ok) throw new Error(`fixtures/${name}.json → ${res.status}`);
    loaded[name] = await res.json();
  }));
  db = loaded;
  db.extraProjects = []; // created this session
  patch();
  return db;
}

function patch() {
  const P = db.project;

  /* -- projects -- */
  // live list: [{id, name, slug, createdAt, privacyMode, budget, director,
  // counts: {corpora, constructs, instruments, goldsets, runs, analyses, briefs}}]
  apiNs.projects.list = async () => {
    const summary = {
      id: P.id,
      name: P.name,
      slug: P.slug,
      createdAt: P.createdAt,
      privacyMode: P.privacyMode,
      budget: clone(P.budget),
      director: clone(P.director),
      counts: {
        corpora: P.corpora.length,
        constructs: db.constructs.constructs.length,
        instruments: db.instruments.instruments.length,
        goldsets: db.goldsets.goldsets.length,
        runs: db.runs.runs.length,
        analyses: (P.analyses ?? []).length,
        briefs: (P.briefs ?? []).length,
      },
    };
    return [summary, ...db.extraProjects.map((x) => clone(x.summary))];
  };
  apiNs.projects.create = async ({ name, privacyMode }) => {
    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || newId("p");
    const proj = {
      id: newId("proj"), name, slug, privacyMode: privacyMode ?? "open", createdAt: new Date().toISOString(),
      budget: { capUSD: null, spentUSD: 0 },
      director: null,
      corpora: [], constructs: [], instruments: [], goldsets: [], analyses: [], briefs: [], runs: [], plans: [],
    };
    db.extraProjects.push({
      slug,
      summary: {
        id: proj.id, name, slug, createdAt: proj.createdAt, privacyMode: proj.privacyMode,
        budget: clone(proj.budget), director: null,
        counts: { corpora: 0, constructs: 0, instruments: 0, goldsets: 0, runs: 0, analyses: 0, briefs: 0 },
      },
      _full: proj,
    });
    return clone(proj);
  };
  apiNs.projects.get = async (slug) => {
    if (slug === P.slug) return projectGraph();
    const extra = db.extraProjects.find((x) => x.slug === slug);
    if (extra) return clone(extra._full);
    return notFound(`project "${slug}"`);
  };
  apiNs.projects.update = async (slug, body = {}) => {
    const proj = slug === P.slug ? P : db.extraProjects.find((x) => x.slug === slug)?._full;
    if (!proj) return notFound(`project "${slug}"`);
    if (body.privacyMode !== undefined && body.privacyMode !== proj.privacyMode) {
      const RANK = { open: 0, "no-training": 1, strict: 2 };
      if (RANK[body.privacyMode] < RANK[proj.privacyMode] && body.confirmDowngrade !== true) {
        throw new apiNs.ApiError("VALIDATION",
          `changing privacy mode from "${proj.privacyMode}" to "${body.privacyMode}" weakens this project's privacy guarantees — repeat the request with {confirmDowngrade: true} to proceed`,
          { status: 400 });
      }
      proj.privacyMode = body.privacyMode;
    }
    if (body.budget !== undefined) {
      proj.budget = proj.budget ?? { capUSD: null, spentUSD: 0 };
      if ("capUSD" in body.budget) proj.budget.capUSD = body.budget.capUSD;
    }
    return slug === P.slug ? projectGraph() : clone(proj);
  };

  /* -- import -- */
  // live: POST import → {importId, mapping: {columns}|null, preview, issues}
  apiNs.imports.upload = async () => {
    await sleep(600); // the parse beat
    return clone(db.import.proposal);
  };
  // live: POST import/confirm → {corpusId, unitCount, junkQueue: {counts, flagged}}
  apiNs.imports.confirm = async () => {
    await sleep(900);
    return clone(db.import.confirmResult);
  };

  /* -- corpora -- */
  // live: {units, total, offset, limit}
  apiNs.corpora.units = async (p, c, params = {}) => {
    const offset = Number(params.offset ?? 0);
    const limit = Number(params.limit ?? 50);
    let list = db.units.units;
    if (params.q) {
      const q = String(params.q).toLowerCase();
      list = list.filter((u) => u.text.toLowerCase().includes(q));
    }
    return { units: clone(list.slice(offset, offset + limit)), total: db.units.total, offset, limit };
  };
  // live scopeOf (routes/corpora.js): the scope block follows the live corpus
  // entry, never the cached read — mirrored here so a fixture re-unitize
  // changes the chip on the NEW corpus's instant read.
  const scopeOf = (corpus) => ({
    textColumn: corpus.textColumn ?? corpus.unitization?.textColumn ?? null,
    scheme: corpus.scheme ?? corpus.unitization?.scheme ?? null,
    unitCount: corpus.unitCount ?? null,
    junk: clone(corpus.junk ?? null),
    metaColumns: corpus.metaColumns ?? null,
    derivedFrom: corpus.derivedFrom ?? null,
  });
  apiNs.corpora.instantRead = async (p, c) => {
    await sleep(120); // < 1s, honestly
    const out = clone(db.instantread);
    const corpus = P.corpora.find((x) => x.id === c);
    if (corpus) {
      out.unitCount = corpus.unitCount ?? out.unitCount;
      out.scope = scopeOf(corpus);
    }
    return out;
  };
  // live: GET corpora/:c/columns → {columns: [{name, role, distinct,
  // missing, values?: [{value, n}]}]} — the unit-text column never appears.
  // Re-unitized corpora fall back to their source corpus's columns.
  apiNs.corpora.columns = async (p, c) => {
    const corpus = P.corpora.find((x) => x.id === c);
    const entry = db.columns[c]
      ?? (corpus?.derivedFrom ? db.columns[corpus.derivedFrom] : null);
    if (!entry) return notFound(`columns for corpus "${c}"`);
    return clone(entry);
  };
  // live: POST corpora/:c/reunitize {textColumn} → {corpusId, unitCount,
  // junk, textColumn, skipped} — a NEW corpus entry; the original is kept.
  apiNs.corpora.reunitize = async (p, c, { textColumn } = {}) => {
    await sleep(900);
    const src = P.corpora.find((x) => x.id === c);
    if (!src) return notFound(`corpus "${c}"`);
    if (!textColumn) {
      throw new apiNs.ApiError("VALIDATION", "textColumn is required", { status: 400 });
    }
    const known = Object.keys(db.units.units[0]?.meta ?? {});
    if (!known.includes(textColumn)) {
      throw new apiNs.ApiError("VALIDATION",
        `"${textColumn}" is not a metadata column of this corpus — columns: ${known.join(", ") || "(none)"}`,
        { status: 400 });
    }
    const skipped = 41; // rows empty in the chosen column
    const unitCount = Math.max(1, (src.unitCount ?? db.units.total) - skipped);
    const junk = { na: 3, short: 9, dup: 24, bot: 7 };
    const scheme = src.scheme ?? src.unitization?.scheme ?? "response";
    const entry = {
      id: newId("corp"),
      name: `${src.name ?? src.id} · text=${textColumn}`,
      ...(src.source ? { source: clone(src.source) } : {}),
      unitization: { scheme, textColumn },
      unitCount,
      createdAt: new Date().toISOString(),
      textColumn,
      scheme,
      junk,
      metaColumns: src.metaColumns ?? known.length,
      sourceName: src.sourceName ?? src.source?.filename ?? null,
      derivedFrom: src.id,
    };
    P.corpora.push(entry);
    return { corpusId: entry.id, unitCount, junk: clone(junk), textColumn, skipped };
  };

  /* -- brief (artifact + SSE) -- */
  apiNs.brief.get = async (p, bid) =>
    (bid === db.brief.id ? clone(db.brief) : notFound(`brief "${bid}"`));
  apiNs.brief.generate = (p, corpusId, handlers = {}) =>
    replaySse(db.brief.paragraphs.map((para) => ({ event: "para", data: { md: para.md, refs: clone(para.refs) } })), {
      gap: 550, jitter: 450,
      onStep: ({ data }) => handlers.onParagraph?.(data),
      onDone: () => {
        // live done: {briefId, paragraphs, themes, issues}
        handlers.onDone?.({ briefId: db.brief.id, paragraphs: db.brief.paragraphs.length, themes: db.brief.themes.length, issues: clone(db.brief.issues) });
        handlers.onClose?.();
      },
    });

  /* -- questionbar -- */
  // live: POST questionbar → {planId, plan}; the plan is the persisted artifact
  apiNs.questionbar.ask = async (p, question) => {
    await sleep(1100); // the Director thinks
    const out = clone(db.plan);
    if (question) out.plan.question = question;
    P.plans = P.plans ?? [];
    if (!P.plans.some((x) => x.planId === out.planId)) P.plans.push(clone(out.plan));
    return { planId: out.planId, plan: out.plan };
  };
  // live: → {planId, constructIds, instrumentIds, runIds}
  apiNs.questionbar.approve = async () => {
    await sleep(400);
    const r = clone(db.plan.approveResult);
    for (const c of db.plan.plan.constructs) {
      if (!db.constructs.constructs.some((k) => k.name === c.name)) {
        db.constructs.constructs.push(clone(c));
      }
    }
    db.plan.plan.instruments.forEach((spec, i) => {
      const id = r.instrumentIds[i] ?? newId("inst");
      if (db.instruments.instruments.some((k) => k.id === id)) return;
      db.instruments.instruments.push({
        id,
        constructId: spec.constructId,
        kind: "judge",
        name: `${spec.constructName} · judge`,
        level: "exploratory",
        version: 1,
        versionHash: newId("hash").slice(-16).padStart(32, "0"),
        frozen: false,
        payload: {
          provider: spec.provider, model: spec.model, snapshot: spec.snapshot,
          params: { temperature: 0, maxTokens: 256 },
          promptTemplate: "Apply the codebook. {{definition}} {{criteria}} {{examples}} {{unit}}",
          schema: { type: "binary" }, rationaleFirst: true, workerClass: spec.workerClass,
        },
        authoredBy: "director",
        humanTouched: false,
        createdAt: new Date().toISOString(),
      });
    });
    // live approve also preflights one PENDING run per instrument (routes/
    // questionbar.js) — mirror it so the post-approve delivery view's run
    // links resolve and "Start" works on each created run
    const planCorpus = P.corpora.find((c) => c.id === db.plan.plan.corpusId) ?? P.corpora.at(-1) ?? null;
    db.plan.plan.instruments.forEach((spec, i) => {
      const runId = r.runIds?.[i];
      if (!runId || db.runs.runs.some((x) => x.id === runId)) return;
      const instId = r.instrumentIds[i] ?? null;
      const inst = db.instruments.instruments.find((x) => x.id === instId) ?? null;
      const per = db.plan.plan.estimate?.perInstrument?.[i] ?? null;
      db.runs.runs.push({
        id: runId,
        instrumentId: instId,
        versionHash: inst?.versionHash ?? "0000000000000000",
        corpusId: planCorpus?.id ?? db.plan.plan.corpusId ?? null,
        status: "pending",
        checkpoint: { done: 0, total: planCorpus?.unitCount ?? db.units.total },
        cost: { estUSD: per?.estUSD ?? 0, actualUSD: 0, inputTokens: 0, outputTokens: 0 },
        escalation: { count: 0, directorModel: P.director?.model ?? null },
        quarantine: [],
        provider: spec.provider ?? "fixtures",
        model: spec.model ?? "fixtures-replay",
        snapshot: spec.snapshot ?? null,
        pinned: Boolean(spec.snapshot),
        capUSD: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
      });
    });
    const stored = (P.plans ?? []).find((x) => x.planId === db.plan.planId);
    if (stored) { stored.status = "approved"; stored.approvedAt = new Date().toISOString(); }
    return r;
  };

  /* -- constructs -- */
  const constructList = () => db.constructs.constructs;
  apiNs.constructs.list = async () => clone(constructList());
  apiNs.constructs.get = async (p, id) => {
    const k = constructList().find((x) => x.id === id);
    return k ? clone(k) : notFound(`construct "${id}"`);
  };
  apiNs.constructs.create = async (p, construct) => {
    const k = {
      criteria: { include: [], exclude: [] }, edgeCases: [], examples: [],
      authoredBy: "human", humanTouched: true, createdAt: new Date().toISOString(),
      ...clone(construct), id: construct.id ?? newId("c"),
    };
    constructList().push(k);
    return clone(k);
  };
  apiNs.constructs.update = async (p, id, construct) => {
    const list = constructList();
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return notFound(`construct "${id}"`);
    list[i] = { ...list[i], ...clone(construct), id, humanTouched: true };
    return clone(list[i]);
  };
  apiNs.constructs.remove = async (p, id) => {
    const list = constructList();
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) list.splice(i, 1);
    return { deleted: id };
  };
  // live: → {constructs: Construct[], proposed: true}
  apiNs.constructs.importFile = async () => {
    await sleep(800);
    return { constructs: clone(db.constructs.importProposals), proposed: true };
  };
  // live: POST constructs/draft {input, corpusId?} → {constructs:
  // proposals[], sampleN} — un-persisted proposals formalizing the USER's
  // concepts. The fixture renames its canned proposals after the typed lines
  // (`name: hint` honored) so the flow feels real; a lone research question
  // returns the bank as-is.
  apiNs.constructs.draft = async (p, { input } = {}) => {
    await sleep(2400); // one Director call's worth of waiting
    const bank = clone(db.constructs.draftProposals ?? []);
    if (!String(input ?? "").trim()) {
      throw new apiNs.ApiError("VALIDATION",
        "draft input is empty — give concept names (one per line, optionally \"name: hint\") or a research question",
        { status: 400 });
    }
    const lines = String(input).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const isQuestion = lines.length === 1 &&
      (lines[0].endsWith("?") || (!lines[0].includes(":") && lines[0].split(/\s+/).length > 6));
    if (isQuestion || bank.length === 0) return { constructs: bank, sampleN: 60 };
    const constructs = lines.map((line, i) => {
      const at = line.indexOf(":");
      const name = (at === -1 ? line : line.slice(0, at)).trim();
      const hint = at === -1 ? null : line.slice(at + 1).trim();
      const tpl = bank[i % bank.length];
      return { ...clone(tpl), name: name || tpl.name, definition: hint || tpl.definition };
    });
    return { constructs, sampleN: 60 };
  };
  // live: → taxonomy artifact {mode, corpusId, sampleN, themes, note, issues, …}
  apiNs.constructs.inductive = async () => {
    await sleep(1400);
    return clone(db.constructs.inductiveTaxonomy);
  };

  /* -- instruments -- */
  const instList = () => db.instruments.instruments;
  apiNs.instruments.list = async () => clone(instList());
  apiNs.instruments.get = async (p, id) => {
    const inst = instList().find((x) => x.id === id);
    return inst ? clone(inst) : notFound(`instrument "${id}"`);
  };
  apiNs.instruments.create = async (p, instrument) => {
    const inst = { level: "exploratory", version: 1, versionHash: newId("hash").slice(-16).padStart(32, "0"), frozen: false, authoredBy: "human", humanTouched: true, createdAt: new Date().toISOString(), ...clone(instrument), id: newId("inst") };
    instList().push(inst);
    return clone(inst);
  };
  apiNs.instruments.update = async (p, id, instrument) => {
    const list = instList();
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return notFound(`instrument "${id}"`);
    if (list[i].frozen) {
      throw new apiNs.ApiError("VALIDATION", "frozen instruments are immutable — send a payload to fork a new version", { status: 400 });
    }
    list[i] = { ...list[i], ...clone(instrument), id, humanTouched: true };
    return clone(list[i]);
  };
  apiNs.instruments.remove = async (p, id) => {
    const list = instList();
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) list.splice(i, 1);
    return { deleted: id };
  };
  apiNs.instruments.compile = async (p, id) => {
    await sleep(1300);
    const inst = instList().find((x) => x.id === id);
    if (!inst) return notFound(`instrument "${id}"`);
    inst.version = (inst.version ?? 1) + 1;
    inst.versionHash = newId("hash").slice(-16).padStart(32, "0");
    inst.authoredBy = "director";
    inst.humanTouched = false;
    return clone(inst);
  };
  // live SSE: iteration events {iteration, versionHash, agreement, kappa,
  // alpha, note, costUSD} then done {instrumentId, level, versionHash,
  // stability, curve, cost}
  apiNs.instruments.silverTune = (p, id, _opts = {}, handlers = {}) =>
    replaySse(db.instruments.silverTune.iterations.map((it) => ({ event: "iteration", data: clone(it) })), {
      gap: 900, jitter: 500,
      onStep: ({ data }) => handlers.onIteration?.(data),
      onDone: () => {
        const inst = instList().find((x) => x.id === id);
        const done = clone(db.instruments.silverTune.done);
        if (inst) {
          if (inst.level === "exploratory") inst.level = "stabilized";
          inst.silver = { goldsetId: "silver_theme1", iterations: clone(done.curve) };
          inst.stability = clone(done.stability);
          done.instrumentId = inst.id;
          done.level = inst.level;
          done.versionHash = inst.versionHash;
        }
        handlers.onDone?.(done);
        handlers.onClose?.();
      },
    });
  // live: → {alpha, pass, level} (k/n persist onto instrument.stability;
  // level = the instrument's level AFTER the check, so the screen never
  // claims a promotion that did not happen)
  apiNs.instruments.stability = async (p, id) => {
    await sleep(1600);
    const inst = instList().find((x) => x.id === id);
    const res = clone(db.instruments.stabilityResult);
    if (inst && !inst.frozen) {
      inst.stability = { alpha: res.alpha, k: 3, n: 100, ranAt: new Date().toISOString() };
      if (res.pass && inst.silver && inst.level === "exploratory") inst.level = "stabilized";
    }
    res.level = inst ? inst.level : null;
    return res;
  };
  // live: → the certificate {frozenAt, goldsetId, agreement, humanAgreement,
  // versionHash, modelPinned}
  apiNs.instruments.freeze = async (p, id, { goldsetId } = {}) => {
    await sleep(700);
    const inst = instList().find((x) => x.id === id);
    if (!inst) return notFound(`instrument "${id}"`);
    const frozenRef = instList().find((x) => x.id === "inst_judge_f");
    inst.frozen = true;
    inst.level = "calibrated";
    inst.certificate = {
      ...clone(frozenRef?.certificate ?? {}),
      frozenAt: new Date().toISOString(),
      goldsetId: goldsetId ?? "g_theme1",
      versionHash: inst.versionHash,
    };
    return clone(inst.certificate);
  };
  // live: → {outputs, cost, quarantine, missing} — quarantine carries the
  // reason ({unitId, code, message}); quarantined units get NO output line,
  // exactly like the engine (previews.quarantine banks per instrument kind)
  apiNs.instruments.preview = async (p, id, { unitIds } = {}) => {
    await sleep(900);
    const inst = instList().find((x) => x.id === id);
    const kindKey = inst?.kind === "dictionary" ? "inst_dict" : "judge";
    const bank = db.instruments.previews[kindKey];
    const wanted = unitIds?.length ? unitIds : bank.map((b) => b.unitId);
    const quarantine = (db.instruments.previews.quarantine?.[kindKey] ?? [])
      .filter((q) => wanted.includes(q.unitId))
      .map(clone);
    const quarantined = new Set(quarantine.map((q) => q.unitId));
    const outputs = wanted
      .filter((uid) => !quarantined.has(uid))
      .map((uid) => clone(bank.find((b) => b.unitId === uid))
        ?? { unitId: uid, juror: inst?.versionHash ?? "fixture", label: "other", confidence: 0.5, rationale: "(no fixture preview for this unit)" })
      .filter(Boolean);
    return { outputs, cost: { actualUSD: 0, inputTokens: 0, outputTokens: 0 }, quarantine, missing: [] };
  };

  /* -- goldsets -- */
  const gsList = () => db.goldsets.goldsets;
  // live list: project.goldsets metas
  apiNs.goldsets.list = async () => gsList().map((g) => goldsetMeta(clone(g)));
  apiNs.goldsets.get = async (p, id) => {
    const g = gsList().find((x) => x.id === id);
    return g ? clone(g) : notFound(`gold set "${id}"`);
  };
  apiNs.goldsets.create = async (p, goldset) => {
    // most recently created corpus — same default the run preflight and
    // instrument previews use, so gold is coded on what instruments read
    const corpusId = goldset.corpusId ?? P.corpora.at(-1)?.id;
    const corpus = P.corpora.find((c) => c.id === corpusId) ?? null;
    const g = {
      id: newId("gs"), constructId: goldset.constructId,
      tier: goldset.tier ?? "gold", design: goldset.design ?? "srs",
      sample: [], coders: [], status: "sampling",
      corpusId,
      // the live GET carries the corpus size so the Sample pane can say
      // "you code n OF populationN"
      populationN: corpus?.unitCount ?? null,
      createdAt: new Date().toISOString(),
    };
    gsList().push(g);
    return clone(g);
  };
  apiNs.goldsets.update = async (p, id, goldset) => {
    const list = gsList();
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return notFound(`gold set "${id}"`);
    if (goldset.status !== undefined) list[i].status = goldset.status;
    return clone(list[i]);
  };
  apiNs.goldsets.remove = async (p, id) => {
    const list = gsList();
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) list.splice(i, 1);
    return { deleted: id };
  };
  // live: → {goldsetId, design, n, sample: [{unitId, pi}]}
  apiNs.goldsets.sample = async (p, id, { design, n } = {}) => {
    await sleep(800);
    const g = gsList().find((x) => x.id === id);
    if (!g) return notFound(`gold set "${id}"`);
    const total = db.units.total || db.units.units.length;
    const count = Math.min(Number(n) || 20, db.units.units.length);
    const pool = db.units.units.filter((u) => !u.flags?.junk);
    g.design = design ?? g.design;
    g.sample = pool.slice(0, count).map((u) => ({ unitId: u.id, pi: count / total }));
    g.status = "coding";
    return { goldsetId: g.id, design: g.design, n: g.sample.length, sample: clone(g.sample) };
  };
  // live coderNextView: {unit: {id, text, pos}|null, construct, progress} —
  // `next` skips HANDLED units: labeled or marked uncodable
  apiNs.goldsets.next = async (p, id, coder) => {
    const g = gsList().find((x) => x.id === id);
    if (!g) return notFound(`gold set "${id}"`);
    const rec = (g.coders ?? []).find((c) => c.coderId === coder);
    const labeled = new Set(Object.keys(rec?.labels ?? {}));
    const uncodableCount = (g.sample ?? []).filter((s) => coderUncodable(rec, s.unitId)).length;
    const nextId = (g.sample ?? []).map((s) => s.unitId)
      .find((uid) => !labeled.has(uid) && !coderUncodable(rec, uid)) ?? null;
    const construct = constructList().find((c) => c.id === g.constructId) ?? null;
    const progress = {
      coderId: coder,
      done: labeled.size,
      uncodable: uncodableCount,
      total: g.sample?.length ?? 0,
      remaining: (g.sample?.length ?? 0) - labeled.size - uncodableCount,
      flagged: rec?.flagged?.length ?? 0,
    };
    if (!nextId) return { unit: null, construct: clone(construct), progress };
    const u = unitById(nextId);
    return {
      unit: u ? { id: u.id, text: u.text, pos: u.pos ?? null } : { id: nextId, text: null, pos: null },
      construct: clone(construct),
      progress,
    };
  };
  // live submitCoderLabel: → progressView {coderId, done, uncodable, total,
  // remaining, flagged}. {uncodable: true} (no label) marks can't-code; a
  // later real label supersedes the mark, and vice versa.
  apiNs.goldsets.label = async (p, id, { coder, unitId, label, memo, flag, uncodable } = {}) => {
    const g = gsList().find((x) => x.id === id);
    if (!g) return notFound(`gold set "${id}"`);
    let rec = g.coders.find((c) => c.coderId === coder);
    if (!rec) {
      rec = { coderId: coder, blind: true, labels: {}, uncodable: [], memos: {}, flagged: [], startedAt: new Date().toISOString(), finishedAt: null };
      g.coders.push(rec);
    }
    rec.uncodable = Array.isArray(rec.uncodable) ? rec.uncodable : [];
    if (uncodable) {
      delete rec.labels[unitId];
      if (!rec.uncodable.includes(unitId)) rec.uncodable.push(unitId);
    } else {
      rec.labels[unitId] = label;
      rec.uncodable = rec.uncodable.filter((u) => u !== unitId);
    }
    if (memo) rec.memos[unitId] = memo;
    if (flag && !rec.flagged.includes(unitId)) rec.flagged.push(unitId);
    const inSample = (u) => g.sample.some((s) => s.unitId === u);
    const done = Object.keys(rec.labels).filter(inSample).length;
    const cantCode = rec.uncodable.filter(inSample).length;
    const total = g.sample.length;
    if (done + cantCode >= total) rec.finishedAt = new Date().toISOString();
    if (g.status === "sampling") g.status = "coding";
    return { coderId: coder, done, uncodable: cantCode, total, remaining: total - done - cantCode, flagged: rec.flagged.length };
  };
  // live: → {humanAgreement, perInstrument, goldLabeled}
  apiNs.goldsets.agreement = async (p, id) => {
    await sleep(350);
    const report = db.goldsets.agreement[id];
    return report ? clone(report) : notFound(`agreement for "${id}"`);
  };
  // live: → {status, adjudicated: <count>, excluded: <count>} —
  // {unitId, label} adopts gold; {unitId, exclude: true} drops the unit from
  // gold permanently (it counts toward no agreement statistic)
  apiNs.goldsets.adjudicate = async (p, id, { unitId, label, exclude } = {}) => {
    const g = gsList().find((x) => x.id === id);
    if (!g) return notFound(`gold set "${id}"`);
    if (exclude) {
      g.excluded = (g.excluded && typeof g.excluded === "object" && !Array.isArray(g.excluded)) ? g.excluded : {};
      g.excluded[unitId] = true;
      if (g.adjudicated) delete g.adjudicated[unitId];
    } else {
      g.adjudicated = g.adjudicated ?? {};
      g.adjudicated[unitId] = label;
    }
    if (g.status === "coding") g.status = "adjudicating";
    const gold = goldLabelMap(g);
    if ((g.sample ?? []).every((s) => gold.has(s.unitId) || goldsetExcludes(g, s.unitId))) g.status = "complete";
    return {
      status: g.status,
      adjudicated: Object.keys(g.adjudicated ?? {}).length,
      excluded: Object.keys(g.excluded ?? {}).length,
    };
  };
  // live: → {goldsetId, unitId, queued: true, n, already?}
  apiNs.goldsets.queue = async (p, id, { unitId } = {}) => {
    const g = gsList().find((x) => x.id === id);
    if (!g) return notFound(`gold set "${id}"`);
    g.sample = g.sample ?? [];
    const already = g.sample.some((s) => s.unitId === unitId);
    if (!already) g.sample.push({ unitId, pi: null, queued: true });
    return { goldsetId: id, unitId, queued: true, n: g.sample.length, ...(already ? { already: true } : {}) };
  };
  // live: → {url, port, coderId, existing?}
  apiNs.goldsets.coderSession = async (p, id, coderId) => {
    await sleep(350);
    db.coderSessions = db.coderSessions ?? new Map();
    const key = `${id}|${coderId}`;
    const existing = db.coderSessions.get(key);
    if (existing) return { ...existing, existing: true };
    const session = { url: `http://127.0.0.1:${7400 + db.coderSessions.size}`, port: 7400 + db.coderSessions.size, coderId };
    db.coderSessions.set(key, session);
    return { ...session };
  };
  apiNs.goldsets.endCoderSession = async (p, id, coderId) => {
    db.coderSessions = db.coderSessions ?? new Map();
    let closed = 0;
    for (const key of [...db.coderSessions.keys()]) {
      if (key.startsWith(`${id}|`) && (!coderId || key === `${id}|${coderId}`)) {
        db.coderSessions.delete(key);
        closed++;
      }
    }
    return { closed };
  };

  /* -- runs -- */
  const runList = () => db.runs.runs;
  // live: preflight → {units, calls, inputTokens, outputTokens, estUSD,
  // etaMin, privacyOk, privacyError?, budget: {capUSD, spentUSD, wouldExceed}}.
  // The canned numbers describe the original 2,500-unit corpus; a different
  // corpusId scales them so the quote follows the chosen corpus honestly.
  apiNs.runs.preflight = async (p, { instrumentId, corpusId } = {}) => {
    await sleep(700);
    const pf = clone(db.runs.preflight[instrumentId] ?? db.runs.preflight.inst_judge_s);
    const corpus = P.corpora.find((c) => c.id === corpusId);
    if (corpus?.unitCount && pf.units && corpus.unitCount !== pf.units) {
      const f = corpus.unitCount / pf.units;
      pf.units = corpus.unitCount;
      pf.calls = Math.round(pf.calls * f);
      pf.inputTokens = Math.round(pf.inputTokens * f);
      pf.outputTokens = Math.round(pf.outputTokens * f);
      pf.estUSD = Math.round(pf.estUSD * f * 100) / 100;
      pf.etaMin = Math.round(pf.etaMin * f);
    }
    return pf;
  };
  // live: → {runId, estUSD, total}
  apiNs.runs.start = async (p, { instrumentId, corpusId, capUSD } = {}) => {
    const inst = instList().find((x) => x.id === instrumentId);
    const pf = db.runs.preflight[instrumentId] ?? { estUSD: 1.4, units: db.units.total };
    const corpus = P.corpora.find((c) => c.id === corpusId) ?? P.corpora.at(-1);
    const run = {
      id: newId("run"),
      instrumentId,
      versionHash: inst?.versionHash ?? "0000000000000000",
      corpusId: corpus?.id ?? corpusId ?? null,
      status: "running",
      checkpoint: { done: 0, total: corpus?.unitCount ?? pf.units ?? db.units.total },
      cost: { estUSD: pf.estUSD ?? 0, actualUSD: 0, inputTokens: 0, outputTokens: 0 },
      escalation: { count: 0, directorModel: P.director?.model ?? null },
      quarantine: [],
      provider: inst?.payload?.provider ?? "fixtures",
      model: inst?.payload?.model ?? "fixtures-replay",
      snapshot: inst?.payload?.snapshot ?? null,
      pinned: Boolean(inst?.payload?.snapshot),
      capUSD: capUSD ?? null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      _live: true,
    };
    runList().push(run);
    return { runId: run.id, estUSD: run.cost.estUSD, total: run.checkpoint.total };
  };
  // live monitor: tick {done, total, costUSD, labelDist, warnings, escalations}
  // then done {runId, status, checkpoint, cost, quarantine, escalations}
  apiNs.runs.monitor = (p, r, handlers = {}) => {
    const run = runList().find((x) => x.id === r);
    const doneOf = (status) => ({
      runId: r,
      status,
      checkpoint: clone(run?.checkpoint ?? null),
      cost: clone(run?.cost ?? null),
      quarantine: clone(run?.quarantine ?? []),
      escalations: run?.escalation?.count ?? 0,
    });
    if (run && run.status === "complete") {
      // already done — one summary tick then done
      return replaySse([{ event: "tick", data: { done: run.checkpoint.done, total: run.checkpoint.total, costUSD: run.cost.actualUSD, labelDist: {}, warnings: [], escalations: run.escalation.count } }], {
        gap: 200,
        onStep: ({ data }) => handlers.onTick?.(data),
        onDone: () => { handlers.onDone?.(doneOf("complete")); handlers.onClose?.(); },
      });
    }
    const script = db.runs.monitorScript;
    const scale = run ? run.checkpoint.total / (script.ticks.at(-1)?.total || 1) : 1;
    return replaySse(script.ticks.map((t) => ({ event: "tick", data: clone(t) })), {
      gap: 420, jitter: 220,
      onStep: ({ data }) => {
        if (run) {
          if (run.status === "paused") return; // hold the needle while paused
          data.done = Math.min(run.checkpoint.total, Math.round(data.done * scale));
          data.total = run.checkpoint.total;
          run.checkpoint = { done: data.done, total: data.total };
          run.cost.actualUSD = data.costUSD;
          run.escalation.count = data.escalations ?? run.escalation.count;
        }
        handlers.onTick?.(data);
      },
      onDone: () => {
        if (run && run.status !== "aborted") {
          run.status = "complete";
          run.checkpoint.done = run.checkpoint.total;
          run.finishedAt = new Date().toISOString();
        }
        handlers.onDone?.(doneOf(run?.status ?? "complete"));
        handlers.onClose?.();
      },
    });
  };
  // live: → {runId, status}
  apiNs.runs.pause = async (p, r) => {
    const run = runList().find((x) => x.id === r);
    if (run) run.status = "paused";
    return { runId: r, status: "paused" };
  };
  apiNs.runs.resume = async (p, r) => {
    const run = runList().find((x) => x.id === r);
    if (run) run.status = "running";
    return { runId: r, status: "running", resumed: true };
  };
  apiNs.runs.abort = async (p, r) => {
    const run = runList().find((x) => x.id === r);
    if (run) { run.status = "aborted"; run.finishedAt = new Date().toISOString(); }
    return { runId: r, status: "aborted" };
  };
  // live: output LINES with escalated: true
  apiNs.runs.escalations = async (p, r) => {
    const esc = db.runs.escalations[r] ?? db.runs.escalations.run_panel_full ?? [];
    return clone(esc);
  };
  // live: {byEntropy: [{unitId, entropy, labels: {juror: label}}],
  // jurorMatrix: {jurors, matrix}, note?}
  apiNs.runs.disagreement = async (p, r) => {
    const d = db.runs.disagreement[r] ?? db.runs.disagreement.run_panel_full;
    return d ? clone(d) : notFound(`disagreement for "${r}"`);
  };
  // live: GET runs/:r/export.csv streams the labeled-data CSV — original
  // columns + <construct> label/confidence/escalated (+ _error when anything
  // quarantined), named <slug>-<construct>-<runId>[-partial].csv. Fixtures
  // download a canned sample of the same shape so the button works offline.
  apiNs.runs.exportCsv = (p, r) => {
    const run = runList().find((x) => x.id === r);
    const inst = run ? instList().find((x) => x.id === run.instrumentId) : null;
    const construct = inst ? constructList().find((x) => x.id === inst.constructId) : null;
    const cSlug = String(construct?.name ?? "construct").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "construct";
    const partial = run && run.status !== "complete" ? "-partial" : "";
    const csv = db.runs.exportCsv ?? "unit_id\r\n";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${p}-${cSlug}-${r}${partial}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  /* -- analyses -- */
  // live: POST analyses → full analysis {id, kind, spec, results, level,
  // evidence: {cells}, createdAt}
  apiNs.analyses.create = async (p, { kind, spec } = {}) => {
    await sleep(1100);
    // Explorer descriptive: spec.runId rode the request
    if (kind === "descriptive" && spec?.runId && db.runs.explore[spec.runId]) {
      const ex = db.runs.explore[spec.runId];
      return {
        id: newId("an"), kind, spec: clone(spec), level: "exploratory",
        results: clone(ex.results),
        evidence: { cells: clone(ex.evidenceCells ?? {}) },
        createdAt: new Date().toISOString(),
      };
    }
    const match = db.analyses.analyses.find((a) => a.kind === kind);
    if (match) {
      const out = clone(match);
      out.id = newId("an");
      out.spec = { ...out.spec, ...clone(spec ?? {}) };
      out.createdAt = new Date().toISOString();
      return out;
    }
    const tpl = clone(db.analyses.templates.descriptive);
    return { id: newId("an"), kind, spec: clone(spec ?? {}), level: tpl.level, results: tpl.results, evidence: tpl.evidence ?? { cells: {} }, createdAt: new Date().toISOString() };
  };
  // live: GET analyses/:id → the persisted artifact; 404 when absent (the
  // workbench falls back to its recompute state on 404)
  apiNs.analyses.get = async (p, id) => {
    const a = db.analyses.analyses.find((x) => x.id === id);
    return a ? clone(a) : notFound(`analysis "${id}"`);
  };
  // convenience (non-route) lookup used only in fixtures mode
  apiNs.analyses.list = async () => clone(db.analyses.analyses);

  /* -- evidence -- */
  // live dossier: {unit, dictionaryHits: [{instrumentId, name, versionHash,
  // hits}], outputs: [{runId, instrumentId, status, model, outputs}],
  // goldLabels: [{goldsetId, tier, status, coders, adjudicated}], sourcePos}
  apiNs.evidence.get = async (p, unitId) => {
    await sleep(180);
    const unit = unitById(unitId);
    const extra = db.evidence[unitId] ?? {};
    if (!unit) return notFound(`unit "${unitId}"`);
    return clone({
      unit,
      dictionaryHits: extra.dictionaryHits ?? [],
      outputs: extra.outputs ?? [],
      goldLabels: extra.goldLabels ?? [],
      sourcePos: extra.sourcePos ?? unit.pos ?? null,
    });
  };

  /* -- reliability -- */
  // live: GET reliability/:constructId?corpusId= → {constructId, corpusId,
  // sources, pairs, notes, retestAvailable?} — a REAL construct with no
  // readings yet gets the honest empty payload, exactly like the live route
  apiNs.reliability.get = async (p, constructId) => {
    const canned = db.reliability[constructId];
    if (canned) return clone(canned);
    const k = constructList().find((x) => x.id === constructId);
    if (!k) return notFound(`construct "${constructId}"`);
    return {
      constructId,
      corpusId: P.corpora.at(-1)?.id ?? null,
      sources: [], pairs: [], notes: [], retestAvailable: false,
    };
  };

  /* -- exports -- */
  // live: → {analysisId, markdown, citations: [{token, hash, type}]}
  apiNs.exports.methods = async () => {
    await sleep(500);
    return clone(db.reports.methods);
  };
  // live: GET exports/methods/preview → the SAME {analysisId, markdown,
  // citations} payload as the export of record, with the preview banner the
  // generator prepends under the title ("> Preview — not an export of
  // record") and NO export.methods ledger event minted. The Reports screen
  // renders this on every visit; demo mode mirrors it exactly.
  apiNs.exports.methodsPreview = async () => {
    await sleep(300);
    const out = clone(db.reports.methods);
    const banner = "> Preview — not an export of record";
    const md = String(out.markdown ?? "");
    const head = md.match(/^(#{1,6} .*\n\n?)/);
    out.markdown = head ? `${head[1]}${banner}\n\n${md.slice(head[1].length)}` : `${banner}\n\n${md}`;
    return out;
  };
  apiNs.exports.replicationContents = async () => clone(db.reports.replication); // fixtures-only helper
  apiNs.exports.download = (p, kind) => {
    // no server to stream a zip in fixtures mode — say so instead of 404ing
    window.concord?.toast?.info?.(
      `Fixtures mode — the ${kind === "report" ? "standalone report" : "replication zip"} streams from the live server.`);
  };

  /* -- report (persisted project artifact: project.report.blocks) -- */
  // live: PUT report {blocks} replaces the layout → {blocks, updatedAt};
  //       POST report/blocks {block} appends → {blocks: count}. The canvas
  //       reads project.report.blocks back through projects.get, so the
  //       in-memory db.project.report is the single source for both here.
  apiNs.report.save = async (p, blocks) => {
    const report = { blocks: clone(blocks ?? []), updatedAt: new Date().toISOString() };
    P.report = report;
    return clone(report);
  };
  apiNs.report.addBlock = async (p, block) => {
    P.report = P.report ?? { blocks: [], updatedAt: null };
    P.report.blocks.push({ ...clone(block), addedAt: new Date().toISOString() });
    P.report.updatedAt = new Date().toISOString();
    return { blocks: P.report.blocks.length };
  };

  /* -- catalog / settings / health -- */
  // live: {providers: {name: [models]}, cachedAt}
  apiNs.catalog.models = async () => clone(db.catalog);
  // live: {keys: {name: {configured, apiKey?, baseUrl?}}, port}
  apiNs.settings.get = async () => clone(db.settings);
  // live PUT: accepts {keys}, {port}, {project: {slug, director, privacyMode,
  // budget}} → merged currentSettings + {keysUpdated?, port?, project?}
  apiNs.settings.update = async (s = {}) => {
    const result = {};
    if (s.keys) {
      for (const [name, entry] of Object.entries(s.keys)) {
        if (entry === null || entry === "") {
          delete db.settings.keys[name];
        } else if (typeof entry === "string") {
          db.settings.keys[name] = { configured: true, apiKey: mask(entry) };
        } else {
          db.settings.keys[name] = {
            configured: Boolean(entry.apiKey),
            ...(entry.apiKey ? { apiKey: mask(entry.apiKey) } : {}),
            ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
          };
        }
      }
      result.keysUpdated = Object.keys(s.keys);
    }
    if (s.port !== undefined) {
      db.settings.port = s.port;
      result.port = s.port;
    }
    if (s.project) {
      const proj = s.project.slug === P.slug ? P : db.extraProjects.find((x) => x.slug === s.project.slug)?._full;
      if (proj && s.project.director !== undefined) proj.director = clone(s.project.director);
      result.project = proj ? (s.project.slug === P.slug ? projectGraph() : clone(proj)) : null;
    }
    return { ...clone(db.settings), ...result };
  };
  // live: {ok, version, providers: {name: boolean}}. `health` is exported as
  // a bare function — module namespaces are frozen, so only the aggregate
  // object's property can be patched. Callers must use api.health()
  // (main.js does).
  apiNs.api.health = async () => ({
    ok: true,
    version: "1.0.0-fixtures",
    providers: { anthropic: true, openai: true, openrouter: false, ollama: true, mock: true },
  });
}

function mask(key) {
  const s = String(key);
  if (s.length <= 7) return "…";
  return `${s.slice(0, 3)}…${s.slice(-4)}`;
}
