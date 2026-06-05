// Analyses: POST computes immediately. The DSL/PPI correction auto-selects
// when the analyzed construct has a COMPLETE human gold set with stored π —
// level "corrected", naive companion always included beside it; otherwise the
// analysis carries the instrument's evidence level.
//
// Honesty rails: no significance stars anywhere; crosstabs report minExpected
// and a warning when the χ² approximation is shaky; exploratory results carry
// no decoration of any kind.
import { ConcordError } from "../core/errors.js";
import { createAnalysis } from "../core/objects.js";
import { loadProject, updateProject } from "../core/store.js";
import * as ledger from "../core/ledger.js";
import { crosstab } from "../stats/descriptives.js";
import { dslProportion, dslDiff, dslOLS, dslLogit } from "../stats/correction.js";
import { ols, logit } from "../stats/models.js";
import { cohenKappa } from "../stats/agreement.js";
import {
  findOr404, requireBody, pdirOf, readCorpusUnits, readGoldset, goldLabelMap, piMap,
  readFinalOutputs, writeJsonAtomic, labelKey, statValue, round6,
} from "./_shared.js";
import path from "node:path";

const EVIDENCE_CAP = 100; // unit ids per evidence cell

// ----------------------------------------------------------- assembly bits

// Latest usable run for an instrument over a corpus (complete preferred).
function pickRun(project, { runId, instrumentId, corpusId }) {
  if (runId) return findOr404(project.runs, runId, "run");
  const candidates = (project.runs ?? [])
    .filter((r) => (!instrumentId || r.instrumentId === instrumentId) && (!corpusId || r.corpusId === corpusId))
    .sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")));
  const run = candidates.find((r) => r.status === "complete") ?? candidates[0];
  if (!run) {
    throw new ConcordError("VALIDATION", "no run found for this instrument/corpus — run the instrument first", { instrumentId, corpusId });
  }
  return run;
}

// Join final outputs with corpus units → rows {unitId, label, meta, text}.
async function assembleRows(project, run, instrument) {
  const outputs = await readFinalOutputs(project.slug, run, instrument);
  const byUnit = new Map(outputs.filter((o) => o.label !== undefined).map((o) => [o.unitId, o]));
  const units = await readCorpusUnits(project.slug, run.corpusId, { filter: (u) => byUnit.has(u.id) });
  return units.map((u) => ({
    unitId: u.id,
    label: byUnit.get(u.id).label,
    meta: u.meta ?? {},
    confidence: byUnit.get(u.id).confidence,
  }));
}

// A complete HUMAN gold set (tier "gold") for the construct, with π stored.
// Silver sets are Director labels — they tune instruments, they do not
// license a Corrected claim.
async function goldFor(project, constructId) {
  const meta = (project.goldsets ?? []).find(
    (g) => g.constructId === constructId && g.tier === "gold" && g.status === "complete",
  );
  if (!meta) return null;
  const gs = await readGoldset(project.slug, meta.id);
  const labels = goldLabelMap(gs);
  const pis = piMap(gs);
  if (labels.size === 0 || pis.size === 0) return null;
  return { goldset: gs, labels, pis };
}

function positiveValueOf(spec, construct) {
  return String(spec.positive ?? construct?.categories?.[0]?.value ?? "yes");
}

// DSL unit rows {yhat, y?, pi?} for a binary-ized outcome over assembled rows.
function dslUnits(rows, gold, positive) {
  return rows.map((r) => {
    const yhat = labelKey(r.label) === labelKey(positive) || String(r.label) === positive ? 1 : 0;
    const out = { yhat };
    if (gold && gold.labels.has(r.unitId)) {
      const gl = gold.labels.get(r.unitId);
      out.y = labelKey(gl) === labelKey(positive) || String(gl) === positive ? 1 : 0;
      out.pi = gold.pis.get(r.unitId);
    }
    return out;
  });
}

const hasGoldRows = (units) => units.some((u) => u.y !== undefined && typeof u.pi === "number");

function tryDsl(fn) {
  try {
    return fn();
  } catch (err) {
    return { error: { code: err?.code ?? "ERROR", message: err?.message ?? String(err) } };
  }
}

function cellPush(cells, key, unitId) {
  let arr = cells[key];
  if (!arr) cells[key] = arr = [];
  if (arr.length < EVIDENCE_CAP) arr.push(unitId);
}

// ------------------------------------------------------------- kinds

function computeDescriptive(rows, gold, spec, construct) {
  const counts = {};
  const cells = {};
  for (const r of rows) {
    const k = String(Array.isArray(r.label) ? JSON.stringify(r.label) : r.label);
    counts[k] = (counts[k] ?? 0) + 1;
    cellPush(cells, k, r.unitId);
  }
  const n = rows.length;
  const distribution = Object.fromEntries(
    Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, c]) => [k, { n: c, share: round6(c / n) }]),
  );
  const results = { n, distribution };
  if (gold) {
    // canonical corrected shape (read by reporting/report, replication,
    // methods): estimator + outcome + cells at the TOP level of results
    const cellsOut = [];
    for (const label of Object.keys(counts)) {
      const units = dslUnits(rows, gold, label);
      if (!hasGoldRows(units)) continue;
      const r = tryDsl(() => dslProportion(units));
      if (r.error) continue;
      cellsOut.push({ group: label, n: counts[label], est: r.est, se: r.se, ciLo: r.ciLo, ciHi: r.ciHi, naive: r.naive });
    }
    if (cellsOut.length > 0) {
      results.estimator = "dslProportion";
      results.outcome = spec.of ?? "label";
      results.groupBy = null;
      results.cells = cellsOut;
    }
  }
  return { results, cells, dslApplied: Boolean(results.cells) };
}

function computeCrosstab(rows, gold, spec, construct) {
  const { rowKey, colKey } = spec;
  if (!rowKey || !colKey) throw new ConcordError("VALIDATION", "crosstab requires spec.rowKey and spec.colKey", {});
  const valueOf = (r, key) => (key === "label"
    ? (Array.isArray(r.label) ? JSON.stringify(r.label) : r.label)
    : r.meta?.[key]);
  const flat = rows.map((r) => ({
    unitId: r.unitId,
    [rowKey]: valueOf(r, rowKey),
    [colKey]: valueOf(r, colKey),
  }));
  const table = crosstab(flat, rowKey, colKey);
  const warnings = [];
  if (typeof table.minExpected === "number" && table.minExpected < 5) {
    warnings.push({
      kind: "min-expected",
      message: `smallest expected cell count is ${Math.round(table.minExpected * 100) / 100} (< 5) — the chi-square approximation is unreliable here`,
      minExpected: table.minExpected,
    });
  }
  const cells = {};
  for (const f of flat) {
    if (f[rowKey] === null || f[rowKey] === undefined || f[colKey] === null || f[colKey] === undefined) continue;
    cellPush(cells, `${f[rowKey]}|${f[colKey]}`, f.unitId);
  }
  const results = { table, warnings };

  // DSL correction when one margin is the machine label and human gold exists:
  // per-group corrected proportion of the positive label, naive beside it.
  // Canonical corrected shape (read by reporting/report, replication,
  // methods): estimator/outcome/groupBy/cells/diff at the TOP level.
  const labelKeyName = rowKey === "label" ? rowKey : colKey === "label" ? colKey : null;
  if (gold && labelKeyName) {
    const groupKeyName = labelKeyName === rowKey ? colKey : rowKey;
    const positive = positiveValueOf(spec, construct);
    const groups = [...new Set(rows.map((r) => String(r.meta?.[groupKeyName])))].sort();
    const cellsOut = [];
    const skipped = [];
    const perGroupUnits = new Map();
    for (const g of groups) {
      const groupRows = rows.filter((r) => String(r.meta?.[groupKeyName]) === g);
      const units = dslUnits(groupRows, gold, positive);
      perGroupUnits.set(g, units);
      if (!hasGoldRows(units)) {
        skipped.push({ group: g, reason: "no gold-labeled units in this group" });
        continue;
      }
      const r = tryDsl(() => dslProportion(units));
      if (r.error) {
        skipped.push({ group: g, reason: r.error.message });
        continue;
      }
      cellsOut.push({ group: g, n: groupRows.length, est: r.est, se: r.se, ciLo: r.ciLo, ciHi: r.ciHi, naive: r.naive });
    }
    if (cellsOut.length > 0) {
      results.estimator = "dslProportion";
      results.outcome = `share of "${positive}"`;
      results.groupBy = groupKeyName;
      results.positive = positive;
      results.cells = cellsOut;
      if (skipped.length > 0) results.skippedGroups = skipped;
      if (groups.length === 2) {
        const [a, b] = groups;
        const ua = perGroupUnits.get(a);
        const ub = perGroupUnits.get(b);
        if (hasGoldRows(ua) && hasGoldRows(ub)) {
          const d = tryDsl(() => dslDiff(ua, ub));
          if (!d.error) results.diff = { a, b, est: d.est, se: d.se, ciLo: d.ciLo, ciHi: d.ciHi, naive: d.naive };
        }
      }
    }
  }
  return { results, cells, dslApplied: Boolean(results.cells) };
}

function computeModel(rows, gold, spec, construct) {
  const xKeys = spec.x;
  if (!Array.isArray(xKeys) || xKeys.length === 0) {
    throw new ConcordError("VALIDATION", "model analysis requires spec.x: [meta keys]", {});
  }
  const family = spec.family ?? "logit";
  const positive = positiveValueOf(spec, construct);
  const usable = [];
  for (const r of rows) {
    const x = xKeys.map((k) => Number(r.meta?.[k]));
    if (x.some((v) => !Number.isFinite(v))) continue;
    const yhat = labelKey(r.label) === labelKey(positive) || String(r.label) === positive ? 1 : 0;
    const row = { unitId: r.unitId, yhat, x };
    if (gold && gold.labels.has(r.unitId)) {
      const gl = gold.labels.get(r.unitId);
      row.y = labelKey(gl) === labelKey(positive) || String(gl) === positive ? 1 : 0;
      row.pi = gold.pis.get(r.unitId);
    }
    usable.push(row);
  }
  if (usable.length <= xKeys.length + 1) {
    throw new ConcordError("VALIDATION", `model needs more usable rows than coefficients (got ${usable.length})`, {});
  }
  const names = ["(Intercept)", ...xKeys];
  const renameCoef = (coef) => coef.map((c, i) => ({ ...c, name: names[i] ?? c.name }));

  if (gold && hasGoldRows(usable)) {
    const fit = family === "linear" ? dslOLS(usable, xKeys.length) : dslLogit(usable, xKeys.length);
    return {
      results: {
        family,
        outcome: `machine label == "${positive}"`,
        estimator: family === "linear" ? "dslOLS" : "dslLogit",
        coef: renameCoef(fit.coef),
        naive: renameCoef(fit.naive),
        n: usable.length,
        nGold: usable.filter((u) => u.y !== undefined).length,
      },
      cells: {},
      dslApplied: true,
    };
  }
  const y = usable.map((u) => u.yhat);
  const X = usable.map((u) => u.x);
  const fit = family === "linear" ? ols(y, X) : logit(y, X);
  const coef = fit.coef.map((est, i) => ({ name: names[i], est, se: fit.seHC1[i] }));
  return { results: { family, outcome: `machine label == "${positive}"`, coef, n: usable.length, ...(fit.converged === false ? { converged: false } : {}) }, cells: {} };
}

async function computeTriangulation(project, spec) {
  const ids = spec.instrumentIds;
  if (!Array.isArray(ids) || ids.length !== 2) {
    throw new ConcordError("VALIDATION", "triangulation requires spec.instrumentIds: [a, b]", {});
  }
  const sides = [];
  for (const id of ids) {
    const instrument = findOr404(project.instruments, id, "instrument");
    const run = pickRun(project, { instrumentId: id, corpusId: spec.corpusId });
    const rows = await assembleRows(project, run, instrument);
    sides.push({ instrument, run, byUnit: new Map(rows.map((r) => [r.unitId, r.label])) });
  }
  const shared = [...sides[0].byUnit.keys()].filter((u) => sides[1].byUnit.has(u));
  if (shared.length === 0) {
    throw new ConcordError("VALIDATION", "the two instruments have no jointly labeled units", {});
  }
  let agree = 0;
  const divergent = [];
  const pairs = [];
  const cells = {};
  for (const u of shared) {
    const a = sides[0].byUnit.get(u);
    const b = sides[1].byUnit.get(u);
    const same = labelKey(a) === labelKey(b);
    if (same) agree++;
    else {
      divergent.push({ unitId: u, a, b });
      cellPush(cells, "divergent", u);
    }
    if (pairs.length < 500) pairs.push({ unitId: u, a, b });
  }
  let kappa = null;
  try {
    const rows = shared.flatMap((u) => [
      { unitId: u, coder: "a", value: statValue(sides[0].byUnit.get(u)) },
      { unitId: u, coder: "b", value: statValue(sides[1].byUnit.get(u)) },
    ]);
    kappa = cohenKappa(rows);
  } catch { /* degenerate → null */ }
  const levelRank = { exploratory: 0, stabilized: 1, calibrated: 2, corrected: 3 };
  const minLevel = sides
    .map((s) => s.instrument.level)
    .sort((a, b) => (levelRank[a] ?? 0) - (levelRank[b] ?? 0))[0];
  return {
    results: {
      instruments: sides.map((s) => ({ instrumentId: s.instrument.id, name: s.instrument.name, kind: s.instrument.kind, level: s.instrument.level, runId: s.run.id })),
      n: shared.length,
      percentAgreement: round6(agree / shared.length),
      kappa,
      divergent: divergent.slice(0, 200),
      pairs,
    },
    cells,
    level: minLevel,
  };
}

function computeSubgroup(rows, gold, spec, construct) {
  const by = spec.by;
  if (!by) throw new ConcordError("VALIDATION", "subgroup analysis requires spec.by (a meta key)", {});
  const positive = positiveValueOf(spec, construct);
  const groups = new Map();
  const cells = {};
  for (const r of rows) {
    const g = String(r.meta?.[by] ?? "");
    let arr = groups.get(g);
    if (!arr) groups.set(g, (arr = []));
    arr.push(r);
    cellPush(cells, g, r.unitId);
  }
  const out = [];
  const cellsOut = []; // canonical corrected cells (report/replication shape)
  for (const [g, groupRows] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const dist = {};
    for (const r of groupRows) {
      const k = String(Array.isArray(r.label) ? JSON.stringify(r.label) : r.label);
      dist[k] = (dist[k] ?? 0) + 1;
    }
    const entry = { group: g, n: groupRows.length, dist };
    if (gold) {
      const units = dslUnits(groupRows, gold, positive);
      if (hasGoldRows(units)) {
        const r = tryDsl(() => dslProportion(units));
        if (!r.error) {
          entry.corrected = { positive, est: r.est, se: r.se, ciLo: r.ciLo, ciHi: r.ciHi, naive: r.naive };
          cellsOut.push({ group: g, n: groupRows.length, est: r.est, se: r.se, ciLo: r.ciLo, ciHi: r.ciHi, naive: r.naive });
        }
      }
    }
    out.push(entry);
  }
  const dslApplied = cellsOut.length > 0;
  return {
    results: {
      by,
      positive,
      groups: out,
      ...(dslApplied ? {
        estimator: "dslProportion",
        outcome: `share of "${positive}"`,
        groupBy: by,
        cells: cellsOut,
      } : {}),
    },
    cells,
    dslApplied,
  };
}

// ------------------------------------------------------------------ route

export default [
  {
    method: "GET",
    pattern: "/api/projects/:p/analyses",
    handler: async (req, res, params) => (await loadProject(params.p)).analyses ?? [],
  },
  {
    method: "POST",
    pattern: "/api/projects/:p/analyses",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const body = requireBody(req, ["kind", "spec"]);
      const { kind } = body;
      const spec = { ...body.spec };

      let computed;
      let level;
      let instrument = null;
      let run = null;

      if (kind === "triangulation") {
        computed = await computeTriangulation(project, spec);
        level = computed.level;
      } else {
        run = pickRun(project, spec);
        spec.runId = run.id;
        spec.corpusId = spec.corpusId ?? run.corpusId;
        instrument = findOr404(project.instruments, spec.instrumentId ?? run.instrumentId, "instrument");
        spec.instrumentId = instrument.id;
        const construct = (project.constructs ?? []).find((c) => c.id === instrument.constructId) ?? null;
        const rows = await assembleRows(project, run, instrument);
        if (rows.length === 0) {
          throw new ConcordError("VALIDATION", `run '${run.id}' has no labeled outputs to analyze`, { runId: run.id });
        }
        const gold = await goldFor(project, instrument.constructId);
        if (gold) spec.goldsetId = gold.goldset.id;

        if (kind === "descriptive") computed = computeDescriptive(rows, gold, spec, construct);
        else if (kind === "crosstab") computed = computeCrosstab(rows, gold, spec, construct);
        else if (kind === "model") computed = computeModel(rows, gold, spec, construct);
        else if (kind === "subgroup") computed = computeSubgroup(rows, gold, spec, construct);
        else throw new ConcordError("VALIDATION", `unknown analysis kind "${kind}"`, { kind });

        // the DSL auto-selection rule: corrected only when a correction was
        // actually estimated; otherwise the instrument's level carries over
        const dslApplied = computed.dslApplied ?? /^dsl/.test(String(computed.results?.estimator ?? ""));
        level = dslApplied ? "corrected" : instrument.level;
      }

      const analysis = createAnalysis({
        kind,
        spec,
        results: computed.results,
        level,
        evidence: { cells: computed.cells },
      });
      await writeJsonAtomic(path.join(pdirOf(params.p), "analyses", `${analysis.id}.json`), analysis);
      await updateProject(params.p, (p) => {
        p.analyses.push({ id: analysis.id, kind, level, createdAt: analysis.createdAt });
      });
      await ledger.append(pdirOf(params.p), "human", "analysis.created", {
        analysisId: analysis.id,
        ...(run ? { runId: run.id } : {}),
        ...(instrument ? { instrumentId: instrument.id } : {}),
      }, {
        kind,
        level,
        estimator: computed.results?.estimator ?? null,
      });
      return analysis;
    },
  },
];
