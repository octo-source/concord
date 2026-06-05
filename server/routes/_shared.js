// Shared plumbing for the route modules. This file is auto-mounted like every
// other routes/*.js module, so it default-exports an EMPTY route array; the
// named exports are the actual API.
//
// Conventions codified here (from the integration reviews):
//   - routes mutate projects ONLY through store.updateProject;
//   - cost roll-up is the route layer's job: addSpend()/withDirectorSpend()
//     accumulate project.budget.spentUSD after each costed operation;
//   - gold labels are "adjudicated-or-consensus": an adjudicated label wins,
//     else a unit's label is the coders' unanimous verdict, else no gold;
//   - agreement reports pass the construct's declared category order into
//     order-sensitive statistics (ordinal α / weighted κ / AC2).
import path from "node:path";
import { mkdir, open, rename, rm, readFile } from "node:fs/promises";
import { ConcordError } from "../core/errors.js";
import { loadProject, updateProject, readNdjson, projectDir, projectsDir } from "../core/store.js";
import { directorCosts } from "../director/director.js";
import {
  percentAgreement, cohenKappa, krippendorffAlpha, gwetAC1, perClass, confusion,
} from "../stats/agreement.js";

export default []; // no routes of its own

// ------------------------------------------------------------ small helpers

export const round6 = (x) => Math.round(x * 1e6) / 1e6;

export const labelKey = (v) =>
  Array.isArray(v) ? JSON.stringify([...v].map(String).sort()) : JSON.stringify(v);

// Agreement-statistics value: scalars stay scalars (String() identity inside
// the stats module), arrays become canonical sorted-set signatures.
export const statValue = (v) =>
  Array.isArray(v) ? JSON.stringify([...v].map(String).sort()) : v;

export function requireBody(req, fields = []) {
  const body = req.body;
  if (body === undefined || body === null || typeof body !== "object") {
    throw new ConcordError("VALIDATION", "request requires a JSON body", {});
  }
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || body[f] === "") {
      throw new ConcordError("VALIDATION", `request body requires "${f}"`, { field: f });
    }
  }
  return body;
}

export function findOr404(list, id, what) {
  const found = (list ?? []).find((x) => x.id === id);
  if (!found) throw new ConcordError("NOT_FOUND", `${what} '${id}' not found`, { id, what });
  return found;
}

export function pdirOf(slug) {
  return projectDir(slug, projectsDir());
}

// ----------------------------------------------------------------- fs bits

let tmpSeq = 0;

// Atomic JSON write (tmp + fsync + rename) — same recipe as core/store, kept
// local so routes do not reach into store internals.
export async function writeJsonAtomic(file, obj) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${tmpSeq++}.tmp`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(JSON.stringify(obj, null, 2), "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return file;
}

// Atomic text write for whole-file artifacts (units.ndjson at import time).
export async function writeTextAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${tmpSeq++}.tmp`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(text, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    if (err instanceof SyntaxError) {
      throw new ConcordError("CORRUPT", `${path.basename(file)} is not valid JSON`, { file });
    }
    throw err;
  }
}

// ----------------------------------------------------------------- corpora

export function corpusUnitsFile(slug, corpusId) {
  return path.join(pdirOf(slug), "corpora", corpusId, "units.ndjson");
}

export async function readCorpusUnits(slug, corpusId, opts = {}) {
  return readNdjson(corpusUnitsFile(slug, corpusId), opts);
}

// Resolve units by id across one corpus (when known) or every corpus.
export async function unitsById(project, ids, { corpusId } = {}) {
  const want = new Set(ids);
  const found = new Map();
  const corpora = corpusId
    ? (project.corpora ?? []).filter((c) => c.id === corpusId)
    : (project.corpora ?? []);
  for (const c of corpora) {
    if (found.size === want.size) break;
    const hits = await readCorpusUnits(project.slug, c.id, { filter: (u) => want.has(u.id) && !found.has(u.id) });
    for (const u of hits) found.set(u.id, u);
  }
  return found;
}

// --------------------------------------------------------------- gold sets

export function goldsetFile(slug, goldsetId) {
  return path.join(pdirOf(slug), "gold", `${goldsetId}.json`);
}

export async function readGoldset(slug, goldsetId) {
  const gs = await readJsonFile(goldsetFile(slug, goldsetId));
  if (!gs) throw new ConcordError("NOT_FOUND", `gold set '${goldsetId}' not found`, { goldsetId });
  return gs;
}

// adjudicated-or-consensus gold labels: Map unitId → label.
//
// NOTE on human-queue rows: the goldsets queue route appends sample rows of
// the form {unitId, pi: null, queued: true}. Their labels DO appear here —
// plain agreement needs no π — but they must NEVER become DSL gold rows
// (π-weighted estimators throw on y-without-pi). The filter lives at the one
// correction assembly point: routes/analyses.js goldFor, which drops every
// unit whose piMap value is not a finite number.
export function goldLabelMap(goldset) {
  const out = new Map();
  const sampleIds = (goldset.sample ?? []).map((s) => s.unitId);
  const coders = (goldset.coders ?? []).filter((c) => c.labels && Object.keys(c.labels).length > 0);
  for (const unitId of sampleIds) {
    const adj = goldset.adjudicated?.[unitId];
    if (adj !== undefined) {
      out.set(unitId, adj);
      continue;
    }
    const votes = coders.map((c) => c.labels[unitId]).filter((v) => v !== undefined);
    if (votes.length === 0) continue;
    const first = labelKey(votes[0]);
    if (votes.every((v) => labelKey(v) === first)) out.set(unitId, votes[0]);
  }
  return out;
}

export function piMap(goldset) {
  const out = new Map();
  for (const s of goldset.sample ?? []) out.set(s.unitId, s.pi);
  return out;
}

// ------------------------------------------------------- agreement reports

// AgreementReport from {unitId, coder, value} rows. Order-sensitive statistics
// receive the construct's declared category order; every coefficient is
// best-effort (degenerate distributions yield null, never a crash).
export function agreementReport(rows, construct, { goldCoder, pairCoders } = {}) {
  const tryStat = (fn) => {
    try { return fn(); } catch { return null; }
  };
  const order = construct?.categories?.map((c) => String(c.value));
  const type = construct?.type;
  const alphaLevel = type === "ordinal" ? "ordinal" : type === "continuous" ? "interval" : "nominal";
  const coderIds = [...new Set(rows.map((r) => r.coder))];

  const unitCoders = new Map();
  for (const r of rows) {
    let s = unitCoders.get(r.unitId);
    if (!s) unitCoders.set(r.unitId, (s = new Set()));
    s.add(r.coder);
  }
  let n = 0;
  for (const s of unitCoders.values()) if (s.size >= 2) n++;

  const report = {
    n,
    coders: coderIds,
    percent: tryStat(() => percentAgreement(rows)),
    kappa: coderIds.length === 2
      ? tryStat(() => (type === "ordinal" && order
        ? cohenKappa(rows, { weighted: "linear", order })
        : cohenKappa(rows)))
      : null,
    alpha: tryStat(() => krippendorffAlpha(rows, {
      level: alphaLevel,
      ...(alphaLevel !== "nominal" && order ? { order } : {}),
    })),
    ac1: tryStat(() => gwetAC1(rows)),
  };
  if (goldCoder) {
    report.perClass = tryStat(() => perClass(rows, goldCoder));
  }
  const [a, b] = pairCoders ?? (coderIds.length === 2 ? coderIds : []);
  if (a && b) {
    const conf = tryStat(() => confusion(rows, a, b));
    if (conf) {
      report.confusion = conf.matrix;
      report.labels = conf.labels;
    }
  }
  return report;
}

// ------------------------------------------------------------ cost roll-up

// Accumulate project.budget.spentUSD. The single roll-up point for run
// actuals, silver-tune spend, ephemeral judging and Director meter deltas.
export async function addSpend(slug, usd) {
  const amount = round6(usd);
  if (!(amount > 0)) return;
  await updateProject(slug, (p) => {
    p.budget = p.budget ?? { capUSD: null, spentUSD: 0 };
    p.budget.spentUSD = round6((p.budget.spentUSD ?? 0) + amount);
  });
}

// Measure the Director meter across `fn` and roll the delta into spentUSD.
export async function withDirectorSpend(project, fn) {
  const before = directorCosts(project).usd;
  try {
    return await fn();
  } finally {
    const delta = directorCosts(project).usd - before;
    if (delta > 0) await addSpend(project.slug, delta).catch(() => {});
  }
}

// ----------------------------------------------------------------- outputs

export function runOutputsFile(slug, runId) {
  return path.join(pdirOf(slug), "runs", runId, "outputs.ndjson");
}

export function finalJurorOf(instrument) {
  return instrument.kind === "panel" ? "aggregate" : instrument.versionHash;
}

// One final verdict per unit out of a run's output lines (the judge line, or
// the aggregate line for panels).
export async function readFinalOutputs(slug, run, instrument) {
  const fin = finalJurorOf(instrument);
  return readNdjson(runOutputsFile(slug, run.id), { filter: (o) => o.juror === fin });
}

// One final verdict per unit out of EPHEMERAL outputs (preview/freeze paths).
export function finalsOf(outputs, instrument) {
  const fin = finalJurorOf(instrument);
  const map = new Map();
  for (const o of outputs ?? []) if (o.juror === fin) map.set(o.unitId, o);
  return map;
}

// --------------------------------------------------------------- settings

export function configDir() {
  return process.env.CONCORD_CONFIG_DIR || path.resolve(process.cwd(), "config");
}

export function keysFile() {
  return path.join(configDir(), "keys.json");
}

export async function readKeysFile() {
  const keys = await readJsonFile(keysFile());
  return keys ?? {};
}

// --------------------------------------------------------------- project IO

export { loadProject, updateProject, readNdjson };
