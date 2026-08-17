// Shared plumbing for the route modules. This file is auto-mounted like every
// other routes/*.js module, so it default-exports an EMPTY route array; the
// named exports are the actual API.
//
// Conventions codified here (from the integration reviews):
//   - routes mutate projects ONLY through store.updateProject;
//   - cost roll-up is the route layer's job: addSpend()/withDirectorSpend()
//     accumulate project.budget.spentUSD after each costed operation;
//   - gold labels are "adjudicated-or-consensus": an adjudicated label wins;
//     else a unit is gold only when ≥2 coders cast identical label votes and
//     no coder holds a can't-code mark on it; else no gold;
//   - agreement reports pass the construct's declared category order into
//     order-sensitive statistics (ordinal α / weighted κ / AC2).
import path from "node:path";
import { mkdir, open, rm, readFile } from "node:fs/promises";
import { ConcordError } from "../core/errors.js";
import {
  renameWithRetry,
  loadProject,
  updateProject,
  readNdjson,
  projectDir,
  projectsDir,
} from "../core/store.js";
import { directorCosts } from "../director/director.js";
import {
  percentAgreement,
  cohenKappa,
  krippendorffAlpha,
  gwetAC1,
  perClass,
  confusion,
} from "../stats/agreement.js";

export default []; // no routes of its own

// ------------------------------------------------------------ small helpers

export const round6 = (x) => Math.round(x * 1e6) / 1e6;

export const labelKey = (v) =>
  Array.isArray(v) ? JSON.stringify([...v].map(String).sort()) : JSON.stringify(v);

// Agreement-statistics value: scalars stay scalars (String() identity inside
// the stats module), arrays become canonical sorted-set signatures.
export const statValue = (v) => (Array.isArray(v) ? JSON.stringify([...v].map(String).sort()) : v);

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

// Every id/slug that becomes a filesystem path segment MUST pass through here
// first. ids are newId() output (prefix_base36) and slugs are [a-z0-9-]; both
// fit [A-Za-z0-9_-]. Anything else — a dot, slash, backslash, or encoded
// traversal that survived URL decoding — is rejected before it can escape the
// project bundle (e.g. "../../../config/keys" reading the key file). The path
// builders below call this, so every route is covered at the seam, and the
// route handlers call it on body-supplied ids that never reach a builder.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
export function safeId(id, what = "id") {
  if (typeof id !== "string" || !SAFE_ID.test(id)) {
    throw new ConcordError("VALIDATION", `invalid ${what} (must be letters, digits, "-" or "_")`, {
      [what]: id,
    });
  }
  return id;
}

export function findOr404(list, id, what) {
  const found = (list ?? []).find((x) => x.id === id);
  if (!found) throw new ConcordError("NOT_FOUND", `${what} '${id}' not found`, { id, what });
  return found;
}

// ------------------------------------------------------------------- naming

// A human-facing rename: a non-empty string of 1..120 characters. Returns the
// validated name; throws VALIDATION otherwise. The one definition shared by
// every artifact that carries an editable `name` label (runs, gold sets).
export function validateName(name, field = "name") {
  if (typeof name !== "string")
    throw new ConcordError("VALIDATION", `${field} must be a string`, { field, value: name });
  if (name.length < 1 || name.length > 120) {
    throw new ConcordError("VALIDATION", `${field} must be 1..120 characters`, {
      field,
      length: name.length,
    });
  }
  return name;
}

// A corpus's display name for run labels. The re-unitize naming scheme stores
// names like "exit-survey.csv · text=response"; that "· text=<col>" suffix is
// scope provenance the corpus screen already shows, so it is stripped from the
// compact "<instrument> · <corpus>" run label to avoid stuttering.
export function corpusDisplayName(corpus) {
  const raw = corpus?.name ?? corpus?.sourceName ?? corpus?.id ?? "corpus";
  return (
    String(raw)
      .replace(/\s*·\s*text=[^·]*$/i, "")
      .trim() || String(raw)
  );
}

// ------------------------------------------------------------------- report

// The report canvas's block vocabulary — the SAME set the report renderer
// accepts (reporting/report.js KINDS). A layout block is chart|table|quote|
// text|methods-excerpt; the canvas persists exactly what the exporter draws.
export const REPORT_BLOCK_KINDS = new Set(["chart", "table", "quote", "text", "methods-excerpt"]);
export const REPORT_MAX_BLOCKS = 100;

// Validate ONE persisted report block: a plain object with a known kind.
// Shape beyond the kind is the renderer's contract (a ref or inline content) —
// validated again at render time — so the canvas stays permissive about
// in-progress blocks while refusing an unknown kind outright.
export function validateReportBlock(block, where = "block") {
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    throw new ConcordError("VALIDATION", `${where} must be an object`, { where });
  }
  if (!REPORT_BLOCK_KINDS.has(block.kind)) {
    throw new ConcordError(
      "VALIDATION",
      `${where} has unknown kind '${block.kind}' — one of: ${[...REPORT_BLOCK_KINDS].join(", ")}`,
      { where, kind: block.kind },
    );
  }
  return block;
}

// Validate a whole replacement layout: an array of ≤100 valid blocks.
export function validateReportBlocks(blocks) {
  if (!Array.isArray(blocks)) {
    throw new ConcordError("VALIDATION", "report blocks must be an array", {
      value: typeof blocks,
    });
  }
  if (blocks.length > REPORT_MAX_BLOCKS) {
    throw new ConcordError("VALIDATION", `a report holds at most ${REPORT_MAX_BLOCKS} blocks`, {
      count: blocks.length,
    });
  }
  blocks.forEach((b, i) => validateReportBlock(b, `blocks[${i}]`));
  return blocks;
}

export function pdirOf(slug) {
  return projectDir(safeId(slug, "project"), projectsDir());
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
    await renameWithRetry(tmp, file);
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
    await renameWithRetry(tmp, file);
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
  return path.join(pdirOf(slug), "corpora", safeId(corpusId, "corpus"), "units.ndjson");
}

export async function readCorpusUnits(slug, corpusId, opts = {}) {
  return readNdjson(corpusUnitsFile(slug, corpusId), opts);
}

// The REAL metadata column names of a unit set (union of meta keys, first-
// seen order). The single definition of "a real column" shared by the
// corpora columns endpoint and stratified-sampling validation — never a
// hardcoded demo list.
export function metaColumnNames(units) {
  const names = [];
  const seen = new Set();
  for (const u of units) {
    for (const k of Object.keys(u.meta ?? {})) {
      if (!seen.has(k)) {
        seen.add(k);
        names.push(k);
      }
    }
  }
  return names;
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
    const hits = await readCorpusUnits(project.slug, c.id, {
      filter: (u) => want.has(u.id) && !found.has(u.id),
    });
    for (const u of hits) found.set(u.id, u);
  }
  return found;
}

// --------------------------------------------------------------- gold sets

export function goldsetFile(slug, goldsetId) {
  return path.join(pdirOf(slug), "gold", `${safeId(goldsetId, "goldset")}.json`);
}

export async function readGoldset(slug, goldsetId) {
  const gs = await readJsonFile(goldsetFile(slug, goldsetId));
  if (!gs) throw new ConcordError("NOT_FOUND", `gold set '${goldsetId}' not found`, { goldsetId });
  return gs;
}

// adjudicated-or-consensus gold labels: Map unitId → label.
//
// THE CONSENSUS RULE: an adjudicated label always wins. Otherwise a unit is
// gold only when ≥2 coders cast label votes, every vote is identical, AND no
// coder holds a can't-code mark on the unit. A single coder's vote is not
// consensus — one voice corroborates nothing. A label opposed by another
// coder's can't-code mark is an OPEN disagreement (it sits in the
// adjudication queue) and belongs to the adjudicator, not the gold standard.
//
// NOTE on human-queue rows: the goldsets queue route appends sample rows of
// the form {unitId, pi: null, queued: true}. Their labels DO appear here —
// plain agreement needs no π — but they must NEVER become DSL gold rows
// (π-weighted estimators throw on y-without-pi). The filter lives at the one
// correction assembly point: routes/analyses.js goldFor, which drops every
// unit whose piMap value is not a finite number.
//
// NOTE on excluded units: goldset.excluded is the array of unit ids the
// adjudicator removed from the gold standard (POST /adjudicate with
// {exclude: true} — the uncodable disposition's terminal state). They are
// skipped HERE, the single gold assembly point, so every consumer — freeze
// calibration, machine-vs-gold agreement, drift checks and DSL correction
// rows (via analyses goldFor) — drops them together.
export function goldLabelMap(goldset) {
  const out = new Map();
  const excluded = new Set(goldset.excluded ?? []);
  const sampleIds = (goldset.sample ?? []).map((s) => s.unitId).filter((id) => !excluded.has(id));
  const coders = goldset.coders ?? [];
  const labelers = coders.filter((c) => c.labels && Object.keys(c.labels).length > 0);
  const cantCode = (c, unitId) =>
    Array.isArray(c.uncodable) ? c.uncodable.includes(unitId) : Boolean(c.uncodable?.[unitId]);
  for (const unitId of sampleIds) {
    const adj = goldset.adjudicated?.[unitId];
    if (adj !== undefined) {
      out.set(unitId, adj);
      continue;
    }
    const votes = labelers.map((c) => c.labels[unitId]).filter((v) => v !== undefined);
    if (votes.length < 2) continue; // a single voice is not consensus
    const first = labelKey(votes[0]);
    if (!votes.every((v) => labelKey(v) === first)) continue;
    if (coders.some((c) => cantCode(c, unitId))) continue; // can't-code vs label → adjudicate
    out.set(unitId, votes[0]);
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
    try {
      return fn();
    } catch {
      return null;
    }
  };
  const order = construct?.categories?.map((c) => String(c.value));
  const type = construct?.type;
  const alphaLevel =
    type === "ordinal" ? "ordinal" : type === "continuous" ? "interval" : "nominal";
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
    kappa:
      coderIds.length === 2
        ? tryStat(() =>
            type === "ordinal" && order
              ? cohenKappa(rows, { weighted: "linear", order })
              : cohenKappa(rows),
          )
        : null,
    alpha: tryStat(() =>
      krippendorffAlpha(rows, {
        level: alphaLevel,
        ...(alphaLevel !== "nominal" && order ? { order } : {}),
      }),
    ),
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
  return path.join(pdirOf(slug), "runs", safeId(runId, "run"), "outputs.ndjson");
}

export function finalJurorOf(instrument) {
  return instrument.kind === "panel" ? "aggregate" : instrument.versionHash;
}

// One final verdict per unit out of a run's output lines (the judge line, or
// the aggregate line for panels). Keyed on the hash the run RAN under —
// the instrument's current hash drifts on unfrozen edits and would blank
// past runs' finals.
export async function readFinalOutputs(slug, run, instrument) {
  const fin =
    instrument.kind === "panel" ? "aggregate" : (run?.versionHash ?? instrument.versionHash);
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
