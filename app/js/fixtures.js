// Fixtures mode — the acceptance artifact for the screens wave. When enabled
// (`?fixtures=1` in the hash query, or localStorage.concordFixtures === "1"),
// every api.js namespace is patched in place to resolve from app/fixtures/*.json
// instead of the network. SSE wrappers replay arrays with small delays so the
// Brief streams, the run monitor ticks, and silver-tuning iterates exactly as
// they would against the live server. Mutations (labels, edits, adjudications,
// new projects) write to an in-memory copy so flows feel real for a session.
//
//   import { fixturesEnabled, installFixtures } from "./fixtures.js";
//   if (fixturesEnabled()) await installFixtures();   // before router start
//
// Nothing here runs (or weighs anything) when fixtures mode is off.

import * as apiNs from "./api.js";

const FILES = [
  "project", "units", "import", "instantread", "brief", "constructs",
  "instruments", "goldsets", "runs", "analyses", "plan", "settings",
  "catalog", "evidence", "reports",
];

let db = null; // in-memory clone of all fixture JSON, mutable for the session

/* ---- flag ------------------------------------------------------------------ */

export function fixturesEnabled() {
  try {
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

function projectGraph() {
  // the project object the app sees — reflects in-session mutations. Run
  // summaries are enriched from the full run records (the live server will
  // serve full records once GET runs/:id exists; api.js lacks that route).
  const p = clone(db.project);
  p.runs = (p.runs ?? []).map((summary) => {
    const full = db.runs.runs.find((r) => r.id === summary.id);
    if (!full) return summary;
    return {
      ...summary,
      ...clone(full),
      done: full.checkpoint?.done ?? summary.done,
      total: full.checkpoint?.total ?? summary.total,
      costUSD: full.cost?.actualUSD ?? summary.costUSD,
    };
  });
  return p;
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
  apiNs.projects.list = async () => {
    const summary = {
      slug: P.slug, name: P.name, privacyMode: P.privacyMode, createdAt: P.createdAt,
      corpusCount: P.corpora.length,
      unitCount: P.corpora.reduce((s, c) => s + (c.unitCount ?? 0), 0),
      ladder: {
        exploratory: P.instruments.filter((i) => i.level === "exploratory").length,
        stabilized: P.instruments.filter((i) => i.level === "stabilized").length,
        calibrated: P.instruments.filter((i) => i.level === "calibrated").length,
        corrected: P.analyses.filter((a) => a.level === "corrected").length,
      },
    };
    return [summary, ...clone(db.extraProjects)];
  };
  apiNs.projects.create = async ({ name, privacyMode }) => {
    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || newId("p");
    const proj = {
      id: newId("proj"), name, slug, privacyMode, createdAt: new Date().toISOString(),
      budget: { capUSD: null, spentUSD: 0 },
      director: clone(db.settings.director),
      corpora: [], constructs: [], instruments: [], goldsets: [], analyses: [], briefs: [], runs: [],
    };
    db.extraProjects.push({ slug, name, privacyMode, corpusCount: 0, unitCount: 0, ladder: {}, _full: proj });
    return clone(proj);
  };
  apiNs.projects.get = async (slug) => {
    if (slug === P.slug) return projectGraph();
    const extra = db.extraProjects.find((x) => x.slug === slug);
    if (extra) return clone(extra._full);
    return notFound(`project "${slug}"`);
  };

  /* -- import -- */
  apiNs.imports.upload = async (p, file) => {
    await sleep(600); // the parse beat
    const proposal = clone(db.import.proposal);
    if (file?.name) proposal.fileName = file.name;
    if (file?.size) proposal.fileSize = file.size;
    return proposal;
  };
  apiNs.imports.confirm = async () => {
    await sleep(900);
    return clone(db.import.confirmResult);
  };

  /* -- corpora -- */
  apiNs.corpora.units = async (p, c, params = {}) => {
    const offset = Number(params.offset ?? 0);
    const limit = Number(params.limit ?? 50);
    let list = db.units.units;
    if (params.q) {
      const q = String(params.q).toLowerCase();
      list = list.filter((u) => u.text.toLowerCase().includes(q));
    }
    return { units: clone(list.slice(offset, offset + limit)), total: db.units.total };
  };
  apiNs.corpora.instantRead = async () => {
    await sleep(120); // < 1s, honestly
    return clone(db.instantread);
  };

  /* -- brief (SSE) -- */
  apiNs.brief.generate = (p, corpusId, handlers = {}) =>
    replaySse(db.brief.paragraphs.map((para) => ({ event: "para", data: clone(para) })), {
      gap: 550, jitter: 450,
      onStep: ({ data }) => handlers.onParagraph?.(data),
      onDone: () => { handlers.onDone?.({ briefId: db.brief.id }); handlers.onClose?.(); },
    });

  /* -- questionbar -- */
  apiNs.questionbar.ask = async (p, question) => {
    await sleep(1100); // the Director thinks
    const out = clone(db.plan);
    if (question) out.question = question;
    return out;
  };
  apiNs.questionbar.approve = async () => {
    await sleep(400);
    const r = clone(db.plan.approveResult);
    for (const c of db.plan.plan.constructs) {
      if (!P.constructs.some((k) => k.name === c.name)) {
        P.constructs.push({ id: newId("k"), name: c.name, type: c.type, authoredBy: "director", humanTouched: false });
      }
    }
    for (const i of db.plan.plan.instruments) {
      if (!P.instruments.some((k) => k.name === i.name)) {
        P.instruments.push({ id: newId("inst"), name: i.name, kind: i.kind, level: "exploratory", version: 1, frozen: false, authoredBy: "director", humanTouched: false });
      }
    }
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
    const k = { authoredBy: "human", humanTouched: true, createdAt: new Date().toISOString(), ...clone(construct), id: construct.id ?? newId("k") };
    constructList().push(k);
    P.constructs.push({ id: k.id, name: k.name, type: k.type, authoredBy: k.authoredBy, humanTouched: k.humanTouched });
    return clone(k);
  };
  apiNs.constructs.update = async (p, id, construct) => {
    const list = constructList();
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return notFound(`construct "${id}"`);
    list[i] = { ...list[i], ...clone(construct), id };
    const meta = P.constructs.find((x) => x.id === id);
    if (meta) Object.assign(meta, { name: list[i].name, humanTouched: list[i].humanTouched });
    return clone(list[i]);
  };
  apiNs.constructs.remove = async (p, id) => {
    const list = constructList();
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) list.splice(i, 1);
    const j = P.constructs.findIndex((x) => x.id === id);
    if (j >= 0) P.constructs.splice(j, 1);
    return { removed: id };
  };
  apiNs.constructs.importFile = async () => {
    await sleep(800);
    return clone(db.constructs.importProposals);
  };
  apiNs.constructs.inductive = async () => {
    await sleep(1400);
    return clone(db.constructs.inductiveProposals);
  };

  /* -- instruments -- */
  const instList = () => db.instruments.instruments;
  apiNs.instruments.list = async () => clone(instList());
  apiNs.instruments.get = async (p, id) => {
    const inst = instList().find((x) => x.id === id);
    return inst ? clone(inst) : notFound(`instrument "${id}"`);
  };
  apiNs.instruments.create = async (p, instrument) => {
    const inst = { level: "exploratory", version: 1, frozen: false, authoredBy: "human", humanTouched: true, createdAt: new Date().toISOString(), ...clone(instrument), id: newId("inst") };
    instList().push(inst);
    P.instruments.push({ id: inst.id, name: inst.name, kind: inst.kind, constructId: inst.constructId, level: inst.level, version: inst.version, frozen: false, authoredBy: inst.authoredBy, humanTouched: inst.humanTouched });
    return clone(inst);
  };
  apiNs.instruments.update = async (p, id, instrument) => {
    const list = instList();
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return notFound(`instrument "${id}"`);
    if (list[i].frozen) {
      throw new apiNs.ApiError("FROZEN", "Instrument is frozen — edits fork a new version.", { status: 400 });
    }
    list[i] = { ...list[i], ...clone(instrument), id };
    const meta = P.instruments.find((x) => x.id === id);
    if (meta) Object.assign(meta, { name: list[i].name, level: list[i].level, humanTouched: list[i].humanTouched });
    return clone(list[i]);
  };
  apiNs.instruments.remove = async (p, id) => {
    const list = instList();
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) list.splice(i, 1);
    return { removed: id };
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
  apiNs.instruments.silverTune = (p, id, opts = {}, handlers = {}) =>
    replaySse(db.instruments.silverTune.iterations.map((it) => ({ event: "iteration", data: clone(it) })), {
      gap: 900, jitter: 500,
      onStep: ({ data }) => handlers.onIteration?.(data),
      onDone: () => {
        const inst = instList().find((x) => x.id === id);
        if (inst && inst.level === "exploratory") inst.level = "stabilized";
        handlers.onDone?.(clone(db.instruments.silverTune.final));
        handlers.onClose?.();
      },
    });
  apiNs.instruments.stability = async (p, id) => {
    await sleep(1600);
    const inst = instList().find((x) => x.id === id);
    if (inst) {
      inst.stability = { ...clone(db.instruments.stabilityResult), ranAt: new Date().toISOString() };
      if (inst.level === "exploratory") inst.level = "stabilized";
      const meta = P.instruments.find((x) => x.id === id);
      if (meta) meta.level = inst.level;
    }
    return clone(db.instruments.stabilityResult);
  };
  apiNs.instruments.freeze = async (p, id, { goldsetId } = {}) => {
    await sleep(700);
    const inst = instList().find((x) => x.id === id);
    if (!inst) return notFound(`instrument "${id}"`);
    const frozenRef = instList().find((x) => x.id === "inst_judge_f");
    inst.frozen = true;
    inst.level = "calibrated";
    inst.certificate = { ...clone(frozenRef?.certificate ?? {}), frozenAt: new Date().toISOString(), goldsetId: goldsetId ?? "g_theme1", versionHash: inst.versionHash };
    const meta = P.instruments.find((x) => x.id === id);
    if (meta) { meta.level = "calibrated"; meta.frozen = true; }
    return clone(inst.certificate);
  };
  apiNs.instruments.preview = async (p, id, { unitIds } = {}) => {
    await sleep(900);
    const inst = instList().find((x) => x.id === id);
    const bank = inst?.kind === "dictionary" ? db.instruments.previews.inst_dict : db.instruments.previews.judge;
    const wanted = unitIds?.length ? unitIds : bank.map((b) => b.unitId);
    return wanted.map((uid) =>
      clone(bank.find((b) => b.unitId === uid) ?? { unitId: uid, label: "other", confidence: 0.5, rationale: "(no fixture preview for this unit)" }));
  };

  /* -- goldsets -- */
  const gsList = () => db.goldsets.goldsets;
  apiNs.goldsets.list = async () => clone(gsList());
  apiNs.goldsets.get = async (p, id) => {
    const g = gsList().find((x) => x.id === id);
    return g ? clone(g) : notFound(`gold set "${id}"`);
  };
  apiNs.goldsets.create = async (p, goldset) => {
    const g = { tier: "gold", design: "srs", status: "sampling", sample: [], coders: [], createdAt: new Date().toISOString(), ...clone(goldset), id: newId("g") };
    gsList().push(g);
    P.goldsets.push({ id: g.id, name: g.name ?? g.id, constructId: g.constructId, tier: g.tier, design: g.design, status: g.status, n: g.sample.length });
    return clone(g);
  };
  apiNs.goldsets.update = async (p, id, goldset) => {
    const list = gsList();
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return notFound(`gold set "${id}"`);
    list[i] = { ...list[i], ...clone(goldset), id };
    return clone(list[i]);
  };
  apiNs.goldsets.remove = async (p, id) => {
    const list = gsList();
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) list.splice(i, 1);
    return { removed: id };
  };
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
    const meta = P.goldsets.find((x) => x.id === id);
    if (meta) { meta.status = "coding"; meta.n = g.sample.length; }
    return clone(g.sample);
  };
  apiNs.goldsets.next = async (p, id, coder) => {
    const g = gsList().find((x) => x.id === id);
    if (!g) return notFound(`gold set "${id}"`);
    let rec = g.coders.find((c) => c.coderId === coder);
    if (!rec) {
      rec = { coderId: coder, blind: true, labels: {}, memos: {}, flagged: [], startedAt: new Date().toISOString(), finishedAt: null };
      g.coders.push(rec);
    }
    const remaining = g.sample.filter((s) => !(s.unitId in rec.labels));
    if (remaining.length === 0) return { done: true, total: g.sample.length, labeled: g.sample.length };
    const unit = unitById(remaining[0].unitId);
    return {
      done: false,
      unit: clone(unit ?? { id: remaining[0].unitId, text: "(unit text unavailable in fixtures)" }),
      total: g.sample.length,
      labeled: g.sample.length - remaining.length,
    };
  };
  apiNs.goldsets.label = async (p, id, { coder, unitId, label, memo, flag } = {}) => {
    const g = gsList().find((x) => x.id === id);
    if (!g) return notFound(`gold set "${id}"`);
    let rec = g.coders.find((c) => c.coderId === coder);
    if (!rec) {
      rec = { coderId: coder, blind: true, labels: {}, memos: {}, flagged: [], startedAt: new Date().toISOString(), finishedAt: null };
      g.coders.push(rec);
    }
    rec.labels[unitId] = label;
    if (memo) rec.memos[unitId] = memo;
    if (flag && !rec.flagged.includes(unitId)) rec.flagged.push(unitId);
    const labeled = Object.keys(rec.labels).filter((u) => g.sample.some((s) => s.unitId === u)).length;
    if (labeled >= g.sample.length) rec.finishedAt = new Date().toISOString();
    return { labeled, total: g.sample.length };
  };
  apiNs.goldsets.agreement = async (p, id) => {
    await sleep(350);
    const report = db.goldsets.agreement[id];
    return report ? clone(report) : notFound(`agreement for "${id}"`);
  };
  apiNs.goldsets.adjudicate = async (p, id, { unitId, label } = {}) => {
    const g = gsList().find((x) => x.id === id);
    if (!g) return notFound(`gold set "${id}"`);
    g.adjudicated = g.adjudicated ?? {};
    g.adjudicated[unitId] = label;
    const d = (g.disagreements ?? []).find((x) => x.unitId === unitId);
    if (d) d.resolved = label;
    const open = (g.disagreements ?? []).filter((x) => !x.resolved).length;
    if (open === 0 && g.coders.every((c) => c.finishedAt)) g.status = "complete";
    return { status: g.status, open };
  };

  /* -- runs -- */
  const runList = () => db.runs.runs;
  apiNs.runs.preflight = async (p, { instrumentId } = {}) => {
    await sleep(700);
    const pf = db.runs.preflight[instrumentId];
    if (pf) return clone(pf);
    return clone({ ...db.runs.preflight.inst_judge_s, privacyNote: "estimated from the nearest fixture instrument" });
  };
  apiNs.runs.start = async (p, { instrumentId, corpusId, capUSD } = {}) => {
    const run = {
      id: newId("run"), instrumentId, corpusId,
      instrumentName: instList().find((x) => x.id === instrumentId)?.name ?? instrumentId,
      level: instList().find((x) => x.id === instrumentId)?.level ?? "exploratory",
      status: "running", checkpoint: { done: 0, total: 2439 },
      cost: { estUSD: db.runs.preflight[instrumentId]?.estUSD ?? 1.4, actualUSD: 0, capUSD: capUSD ?? null },
      escalation: { count: 0, directorModel: db.settings.director.model },
      startedAt: new Date().toISOString(), finishedAt: null,
      provider: "fixtures", model: "fixtures-replay", pinned: true,
      labelDist: {}, warnings: [], _live: true,
    };
    runList().push(run);
    P.runs.push({ id: run.id, instrumentId, corpusId, status: "running", done: 0, total: 2439, costUSD: 0 });
    return { runId: run.id };
  };
  apiNs.runs.monitor = (p, r, handlers = {}) => {
    const run = runList().find((x) => x.id === r);
    if (run && run.status === "complete") {
      // already done — one summary tick then done
      return replaySse([{ event: "tick", data: { done: run.checkpoint.done, total: run.checkpoint.total, costUSD: run.cost.actualUSD, labelDist: clone(run.labelDist), warnings: [], escalations: run.escalation.count } }], {
        gap: 200,
        onStep: ({ data }) => handlers.onTick?.(data),
        onDone: () => { handlers.onDone?.({ runId: r, status: "complete" }); handlers.onClose?.(); },
      });
    }
    const script = db.runs.monitorScript;
    return replaySse(script.ticks.map((t) => ({ event: "tick", data: clone(t) })), {
      gap: 420, jitter: 220,
      onStep: ({ data }) => {
        if (run) {
          if (run.status === "paused") return; // hold the needle while paused
          run.checkpoint = { done: data.done, total: data.total };
          run.cost.actualUSD = data.costUSD;
          run.labelDist = clone(data.labelDist);
          run.escalation.count = data.escalations ?? run.escalation.count;
          const meta = P.runs.find((x) => x.id === r);
          if (meta) { meta.done = data.done; meta.costUSD = data.costUSD; }
        }
        handlers.onTick?.(data);
      },
      onDone: () => {
        if (run && run.status !== "aborted") {
          run.status = "complete";
          run.finishedAt = new Date().toISOString();
          const meta = P.runs.find((x) => x.id === r);
          if (meta) meta.status = "complete";
        }
        handlers.onDone?.({ runId: r, status: run?.status ?? "complete" });
        handlers.onClose?.();
      },
    });
  };
  apiNs.runs.pause = async (p, r) => {
    const run = runList().find((x) => x.id === r);
    if (run) run.status = "paused";
    return { status: "paused" };
  };
  apiNs.runs.resume = async (p, r) => {
    const run = runList().find((x) => x.id === r);
    if (run) run.status = "running";
    return { status: "running" };
  };
  apiNs.runs.abort = async (p, r) => {
    const run = runList().find((x) => x.id === r);
    if (run) { run.status = "aborted"; run.finishedAt = new Date().toISOString(); }
    const meta = P.runs.find((x) => x.id === r);
    if (meta) meta.status = "aborted";
    return { status: "aborted" };
  };
  apiNs.runs.escalations = async (p, r) => {
    const esc = db.runs.escalations[r] ?? db.runs.escalations.run_panel_full ?? [];
    return clone(esc);
  };
  apiNs.runs.disagreement = async (p, r) => {
    const d = db.runs.disagreement[r] ?? db.runs.disagreement.run_panel_full;
    return d ? clone(d) : notFound(`disagreement for "${r}"`);
  };

  /* -- analyses -- */
  apiNs.analyses.create = async (p, { kind, spec } = {}) => {
    await sleep(1100);
    // descriptive/explore requests resolve from the run's explore payload
    if (kind === "descriptive" && spec?.runId && db.runs.explore[spec.runId]) {
      return { id: newId("an"), kind, spec: clone(spec), level: "exploratory", results: clone(db.runs.explore[spec.runId]) };
    }
    const match = db.analyses.analyses.find((a) => a.kind === kind);
    if (match) {
      const out = clone(match);
      out.id = newId("an");
      out.spec = { ...out.spec, ...clone(spec ?? {}) };
      return out;
    }
    const tpl = clone(db.analyses.templates.descriptive);
    return { id: newId("an"), kind, spec: clone(spec ?? {}), level: tpl.level, results: tpl.results };
  };
  // convenience (non-route) lookups used by screens in fixtures mode
  apiNs.analyses.list = async () => clone(db.analyses.analyses);
  apiNs.analyses.get = async (p, id) => {
    const a = db.analyses.analyses.find((x) => x.id === id);
    return a ? clone(a) : notFound(`analysis "${id}"`);
  };

  /* -- evidence -- */
  apiNs.evidence.get = async (p, unitId) => {
    await sleep(180);
    const unit = unitById(unitId);
    const extra = db.evidence[unitId] ?? {};
    if (!unit && !extra.unit) return notFound(`unit "${unitId}"`);
    return clone({
      unit: extra.unit ?? unit,
      lang: extra.lang ?? unit?.lang,
      level: extra.level,
      anonymized: extra.anonymized,
      dictionaryHits: extra.dictionaryHits ?? [],
      outputs: extra.outputs ?? [],
      goldLabels: extra.goldLabels ?? {},
      sourcePos: extra.sourcePos ?? unit?.pos,
    });
  };

  /* -- exports -- */
  apiNs.exports.methods = async () => {
    await sleep(500);
    return clone(db.reports.methods);
  };
  apiNs.exports.replicationContents = async () => clone(db.reports.replication); // fixtures-only helper
  apiNs.exports.download = (p, kind) => {
    // no server to stream a zip in fixtures mode — say so instead of 404ing
    window.concord?.toast?.info?.(
      `Fixtures mode — the ${kind === "report" ? "standalone report" : "replication zip"} streams from the live server.`);
  };

  /* -- catalog / settings / health -- */
  apiNs.catalog.models = async () => clone(db.catalog);
  apiNs.settings.get = async () => clone(db.settings);
  apiNs.settings.update = async (s) => {
    deepMerge(db.settings, s ?? {});
    return clone(db.settings);
  };
  // `health` is exported as a bare function — module namespaces are frozen, so
  // only the aggregate object's property can be patched. Callers must use
  // api.health() (main.js does).
  apiNs.api.health = async () => ({
    ok: true, version: "1.0.0-fixtures",
    providers: Object.fromEntries(Object.entries(db.settings.providers).map(([k, v]) => [k, Boolean(v.reachable)])),
  });
}

function deepMerge(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === "object" && !Array.isArray(v) && target[k] && typeof target[k] === "object") {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
}
