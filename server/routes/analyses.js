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
import { crosstab, cooccurrence } from "../stats/descriptives.js";
import { detect } from "../ingest/mapping.js";
import { dslProportion, dslDiff, dslOLS, dslLogit } from "../stats/correction.js";
import { ols, logit } from "../stats/models.js";
import { cohenKappa } from "../stats/agreement.js";
import {
  findOr404, requireBody, pdirOf, readCorpusUnits, readGoldset, goldLabelMap, piMap,
  writeJsonAtomic, readJsonFile, labelKey, statValue, round6,
  readNdjson, runOutputsFile, safeId,
} from "./_shared.js";
import { finalJurorOfRun } from "../runs/engine.js";
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
// Final verdicts key on the hash the run RAN under (run.versionHash, via
// finalJurorOfRun) — an unfrozen instrument edited after the run would
// otherwise leave every analysis empty ("no labeled outputs").
async function assembleRows(project, run, instrument) {
  const fin = finalJurorOfRun(run, instrument);
  const outputs = await readNdjson(runOutputsFile(project.slug, run.id), { filter: (o) => o.juror === fin });
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
  // CRITICAL INVARIANT: human-queue rows ({pi: null, queued: true} — written
  // by POST goldsets/:g/queue) are NOT design-sampled. They may carry
  // adjudicated labels for AGREEMENT reading (plain agreement needs no π),
  // but they must never become DSL gold rows: the π-weighted estimators
  // throw on y-without-pi. This is the single assembly point for correction
  // gold, so the filter lives here.
  for (const [unitId, pi] of pis) {
    if (typeof pi !== "number" || !Number.isFinite(pi)) {
      pis.delete(unitId);
      labels.delete(unitId);
    }
  }
  if (labels.size === 0 || pis.size === 0) return null;
  return { goldset: gs, labels, pis };
}

// The AGREEMENT gold for the subgroup reliability audit: every adjudicated-
// or-consensus label on a complete human gold set, INCLUDING π-null
// human-queue rows — plain agreement needs no π, only the DSL estimators do
// (goldFor above stays the single π-filtered assembly point).
async function goldAgreementFor(project, constructId) {
  const meta = (project.goldsets ?? []).find(
    (g) => g.constructId === constructId && g.tier === "gold" && g.status === "complete",
  );
  if (!meta) return null;
  const gs = await readGoldset(project.slug, meta.id);
  const labels = goldLabelMap(gs);
  if (labels.size === 0) return null;
  return { goldset: gs, labels };
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

// ----------------------------------------------------- the Explorer contract

// H2's Explorer reads a descriptive analysis computed over a specific run.
// When the REQUEST carries spec.runId, the descriptive results additionally
// carry the screen-ready surfaces, exactly this shape:
//   prevalence:       [{label, count, share}] from aggregate-or-single finals
//                     (multilabel verdicts count each label)
//   crosstabs:        [{by, table, flaggedNote?}] — the top 2 categorical-ish
//                     metadata splits, ranked by χ²; flaggedNote carries the
//                     min-expected honesty warning when the χ² approximation
//                     is shaky
//   cooccurrence:     {labels, matrix} — ONLY where labels genuinely co-occur
//                     (multilabel verdicts, or a panel's flagged no-consensus
//                     units read through their juror labels); omitted otherwise
//   calibrationNudge: {constructName, estUnits, estMinutes} — the first
//                     instrument still below calibrated points at its
//                     construct; omitted when everything is calibrated
const NUDGE_EST = { estUnits: 150, estMinutes: 35 };

async function explorerResults(project, run, instrument, construct, rows) {
  const out = {};
  const n = rows.length;
  const multilabel = construct?.type === "multilabel" || rows.some((r) => Array.isArray(r.label));

  // -- prevalence
  const counts = new Map();
  for (const r of rows) {
    for (const l of Array.isArray(r.label) ? r.label : [r.label]) {
      const k = String(l);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  out.prevalence = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([label, count]) => ({ label, count, share: round6(count / n) }));

  // -- top-2 metadata crosstabs ranked by χ² (categorical columns plus
  //    low-cardinality numerics; id/text/date columns never crosstab)
  const { columns } = detect(rows.map((r) => r.meta ?? {}));
  const keys = columns
    .filter((c) => c.role === "categorical" || (c.role === "numeric" && c.stats.distinct <= 12))
    .map((c) => c.name);
  const tabs = [];
  for (const by of keys) {
    const flat = rows.map((r) => ({
      label: Array.isArray(r.label) ? JSON.stringify(r.label) : r.label,
      [by]: r.meta?.[by],
    }));
    let table;
    try {
      table = crosstab(flat, "label", by);
    } catch {
      continue; // a degenerate split is not worth probing
    }
    const xt = { by, table };
    if (typeof table.minExpected === "number" && table.minExpected < 5) {
      xt.flaggedNote = `smallest expected cell count is ${Math.round(table.minExpected * 100) / 100} (< 5) — the chi-square approximation is unreliable on this split`;
    }
    tabs.push(xt);
  }
  tabs.sort((a, b) => (b.table.chi2 ?? -Infinity) - (a.table.chi2 ?? -Infinity));
  out.crosstabs = tabs.slice(0, 2);

  // -- co-occurrence
  if (multilabel) {
    const sets = rows.map((r) => (Array.isArray(r.label) ? r.label.map(String) : [String(r.label)]));
    out.cooccurrence = cooccurrence(sets);
  } else if (instrument.kind === "panel") {
    // flagged (no-consensus) units: the juror labels that split co-occur.
    // readNdjson already returns [] for a missing file, so a blanket catch only
    // ever swallowed real corruption (BAD_NDJSON) or a transient I/O fault —
    // silently dropping the co-occurrence supplement. Narrow to the benign
    // missing-file case; let corruption/I-O faults propagate (the main
    // assembleRows path above does not swallow either).
    const lines = await readNdjson(runOutputsFile(project.slug, run.id)).catch((err) => {
      if (err?.code === "NOT_FOUND" || err?.code === "ENOENT") return [];
      throw err;
    });
    const flagged = new Set(lines.filter((l) => l.juror === "aggregate" && l.flagged).map((l) => l.unitId));
    if (flagged.size > 0) {
      const byUnit = new Map();
      for (const l of lines) {
        if (!flagged.has(l.unitId) || l.juror === "aggregate" || l.label === undefined) continue;
        let s = byUnit.get(l.unitId);
        if (!s) byUnit.set(l.unitId, (s = new Set()));
        s.add(String(l.label));
      }
      if (byUnit.size > 0) out.cooccurrence = cooccurrence([...byUnit.values()].map((s) => [...s]));
    }
  }

  // -- the quiet calibration nudge, priced
  const next = (project.instruments ?? []).find((i) => i.level !== "calibrated");
  if (next) {
    const k = (project.constructs ?? []).find((c) => c.id === next.constructId);
    out.calibrationNudge = { constructName: k?.name ?? next.constructId, ...NUDGE_EST };
  }
  return out;
}

// ------------------------------------------------------------- kinds

function computeDescriptive(rows, gold, spec, _construct) {
  const counts = {};
  const cells = {};
  for (const r of rows) {
    const k = String(Array.isArray(r.label) ? JSON.stringify(r.label) : r.label);
    counts[k] = (counts[k] ?? 0) + 1;
    cellPush(cells, k, r.unitId);
  }
  const n = rows.length;
  // Every distribution entry is a RAW machine-label proportion and carries
  // that provenance explicitly (corrected: false): when DSL cells ride beside
  // it in a "corrected" analysis, the client must never stamp the corrected ◉
  // on these shares — only results.cells holds corrected numbers.
  const distribution = Object.fromEntries(
    Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, c]) => [k, { n: c, share: round6(c / n), corrected: false }]),
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
      // the TRUE divergent count: results.divergent is sliced to 200 and the
      // evidence cell caps at 100 ids, so the honest total must ride here
      divergentN: divergent.length,
      divergent: divergent.slice(0, 200),
      pairs,
    },
    cells,
    level: minLevel,
  };
}

// Subgroup reliability audit (design §6.7): machine-vs-gold agreement and
// error rates by metadata group — a validity tool and bias check. Requires a
// COMPLETE human gold set (the 400 lives in the POST handler); per group it
// reports n, the label distribution (dist), goldN, percent agreement, κ
// (null + note when degenerate), error rate, and flags groups whose
// agreement sits >0.1 below the overall. DSL-corrected per-group shares
// still ride where π-bearing gold reaches (the canonical corrected shape
// reporting/replication read).
const FLAG_GAP = 0.1;

function machineGoldAgreement(rowsWithGold, goldLabels) {
  const goldN = rowsWithGold.length;
  if (goldN === 0) return { goldN: 0, percentAgreement: null, kappa: null, errorRate: null };
  let agree = 0;
  const pairRows = [];
  for (const r of rowsWithGold) {
    const gl = goldLabels.get(r.unitId);
    if (labelKey(r.label) === labelKey(gl)) agree++;
    pairRows.push(
      { unitId: r.unitId, coder: "machine", value: statValue(r.label) },
      { unitId: r.unitId, coder: "gold", value: statValue(gl) },
    );
  }
  const out = {
    goldN,
    percentAgreement: agree / goldN, // raw — callers round for display
    errorRate: (goldN - agree) / goldN,
    kappa: null,
  };
  try {
    out.kappa = cohenKappa(pairRows);
  } catch (err) {
    out.kappaNote = err?.message ?? String(err);
  }
  return out;
}

function computeSubgroup(rows, gold, goldAgreement, spec, construct) {
  const by = spec.by;
  if (!by) throw new ConcordError("VALIDATION", "subgroup analysis requires spec.by (a meta key)", {});
  const positive = positiveValueOf(spec, construct);
  const goldLabels = goldAgreement.labels;
  const groups = new Map();
  const cells = {};
  for (const r of rows) {
    const g = String(r.meta?.[by] ?? "");
    let arr = groups.get(g);
    if (!arr) groups.set(g, (arr = []));
    arr.push(r);
    cellPush(cells, g, r.unitId);
  }

  // overall machine-vs-gold reference (raw, unrounded — flags compare on it)
  const allGoldRows = rows.filter((r) => goldLabels.has(r.unitId));
  if (allGoldRows.length === 0) {
    throw new ConcordError(
      "VALIDATION",
      "the subgroup reliability audit compares machine labels to gold within each group, but none of this run's units carry a gold label — calibrate first on this corpus, then re-run",
      { by, goldsetId: goldAgreement.goldset.id },
    );
  }
  const overallRaw = machineGoldAgreement(allGoldRows, goldLabels);
  const overall = {
    goldN: overallRaw.goldN,
    percentAgreement: round6(overallRaw.percentAgreement),
    kappa: overallRaw.kappa === null ? null : round6(overallRaw.kappa),
    errorRate: round6(overallRaw.errorRate),
    ...(overallRaw.kappaNote ? { note: overallRaw.kappaNote } : {}),
  };

  const out = [];
  const cellsOut = []; // canonical corrected cells (report/replication shape)
  for (const [g, groupRows] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const dist = {};
    for (const r of groupRows) {
      const k = String(Array.isArray(r.label) ? JSON.stringify(r.label) : r.label);
      dist[k] = (dist[k] ?? 0) + 1;
    }
    const entry = { group: g, n: groupRows.length, dist };

    // -- agreement audit over the gold units in this group
    const a = machineGoldAgreement(groupRows.filter((r) => goldLabels.has(r.unitId)), goldLabels);
    entry.goldN = a.goldN;
    if (a.goldN === 0) {
      entry.percentAgreement = null;
      entry.kappa = null;
      entry.errorRate = null;
      entry.flagged = false; // unreadable, not bad — say so instead of flagging
      entry.note = "no gold-labeled units in this group — the audit cannot read it; extend the gold sample to cover it";
    } else {
      entry.percentAgreement = round6(a.percentAgreement);
      entry.kappa = a.kappa === null ? null : round6(a.kappa);
      entry.errorRate = round6(a.errorRate);
      // the flag compares RAW agreements so display rounding never flips it
      entry.flagged = overallRaw.percentAgreement - a.percentAgreement > FLAG_GAP;
      if (a.kappaNote) entry.note = a.kappaNote;
    }

    // -- DSL-corrected share where π-bearing gold reaches the group
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
      overall,
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
    // The persisted artifact behind a workbench deep link: the full analysis
    // {id, kind, spec, results, level, evidence, createdAt} as written by
    // POST (analyses/<id>.json). Absent → 404 (the screen keeps its honest
    // recompute state for that case).
    method: "GET",
    pattern: "/api/projects/:p/analyses/:id",
    handler: async (req, res, params) => {
      await loadProject(params.p); // unknown project → 404 before any file read
      safeId(params.id, "analysis"); // never let a traversal id reach the path
      const analysis = await readJsonFile(path.join(pdirOf(params.p), "analyses", `${params.id}.json`));
      if (!analysis) {
        throw new ConcordError("NOT_FOUND", `analysis '${params.id}' not found`, { analysisId: params.id });
      }
      return analysis;
    },
  },
  {
    method: "POST",
    pattern: "/api/projects/:p/analyses",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const body = requireBody(req, ["kind", "spec"]);
      const { kind } = body;
      const spec = { ...body.spec };
      // the Explorer contract triggers on the REQUEST naming a run — a spec
      // that only names instrument/corpus is the plain descriptive path
      const wantExplorer = kind === "descriptive" && Boolean(body.spec?.runId);

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
        let gold = await goldFor(project, instrument.constructId);
        let goldDesignNote = null;
        if (gold) {
          spec.goldsetId = gold.goldset.id;
          // Uncertainty-ranked gold carries NOMINAL π — not an inclusion
          // probability. Feeding it to the π-weighted DSL estimators would
          // mint a "corrected" number whose design assumption is false, so
          // it never licenses correction (it still serves the agreement
          // reading in the subgroup audit, which needs no π).
          if (gold.goldset.design === "uncertainty") {
            goldDesignNote = "Gold drawn by uncertainty ranking: π is nominal, so design-based correction does not apply.";
            gold = null;
          }
        }

        if (kind === "descriptive") {
          computed = computeDescriptive(rows, gold, spec, construct);
          if (wantExplorer) {
            Object.assign(computed.results, await explorerResults(project, run, instrument, construct, rows));
          }
        } else if (kind === "crosstab") computed = computeCrosstab(rows, gold, spec, construct);
        else if (kind === "model") computed = computeModel(rows, gold, spec, construct);
        else if (kind === "subgroup") {
          // the reliability audit is undefined without human gold to compare to
          const goldAgreement = await goldAgreementFor(project, instrument.constructId);
          if (!goldAgreement) {
            throw new ConcordError(
              "VALIDATION",
              "the subgroup reliability audit compares machine labels to gold within each group; calibrate first — complete a human gold set for this construct, then re-run the audit",
              { constructId: instrument.constructId },
            );
          }
          spec.goldsetId = spec.goldsetId ?? goldAgreement.goldset.id;
          computed = computeSubgroup(rows, gold, goldAgreement, spec, construct);
        } else throw new ConcordError("VALIDATION", `unknown analysis kind "${kind}"`, { kind });

        // the DSL auto-selection rule: corrected only when a correction was
        // actually estimated; otherwise the instrument's level carries over
        // (an uncertainty-design gold set never reaches the estimators, so
        // its analyses cap below corrected and carry the note saying why)
        if (goldDesignNote) computed.results.note = goldDesignNote;
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
