// Descriptive statistics: crosstabs with χ², co-occurrence matrices, Pearson
// correlation matrices. Pure deterministic functions.
import { ConcordError } from "../core/errors.js";
import { chi2Cdf } from "./distributions.js";

function bad(message, details = {}) {
  return new ConcordError("E_STAT_INPUT", message, details);
}

// Deterministic label sort: numeric ascending when every label is a finite
// number, else plain UTF-16 string order (no locale dependence).
function sortLabels(labels) {
  const arr = [...labels];
  const allNumeric = arr.every((v) => typeof v === "number" && Number.isFinite(v));
  if (allNumeric) return arr.sort((a, b) => a - b);
  return arr.map(String).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// crosstab(units, rowKey, colKey) → {rows, cols, matrix, rowTotals, colTotals,
// total, expected, chi2, df, p}. Units whose row or col value is null/undefined
// are skipped. chi2/p are null when df = 0 (no significance theater on a line).
export function crosstab(units, rowKey, colKey) {
  if (!Array.isArray(units)) throw bad("crosstab requires an array of units");
  if (typeof rowKey !== "string" || typeof colKey !== "string") {
    throw bad("crosstab requires string row/col keys");
  }
  const counts = new Map(); // rowLabel -> Map(colLabel -> n)
  const rowSet = new Set();
  const colSet = new Set();
  let total = 0;
  for (const u of units) {
    const r = u?.[rowKey];
    const c = u?.[colKey];
    if (r === null || r === undefined || c === null || c === undefined) continue;
    rowSet.add(r);
    colSet.add(c);
    let inner = counts.get(r);
    if (!inner) {
      inner = new Map();
      counts.set(r, inner);
    }
    inner.set(c, (inner.get(c) || 0) + 1);
    total++;
  }
  if (total === 0) {
    throw new ConcordError("E_STAT_INSUFFICIENT", "crosstab has no usable units", {
      rowKey,
      colKey,
    });
  }
  const rows = sortLabels(rowSet);
  const cols = sortLabels(colSet);
  const matrix = rows.map((r) =>
    cols.map((c) => counts.get(r)?.get(c) || 0)
  );
  const rowTotals = matrix.map((row) => row.reduce((a, b) => a + b, 0));
  const colTotals = cols.map((_, j) => matrix.reduce((a, row) => a + row[j], 0));
  const expected = rows.map((_, i) =>
    cols.map((_, j) => (rowTotals[i] * colTotals[j]) / total)
  );
  const df = (rows.length - 1) * (cols.length - 1);
  let chi2 = null;
  let p = null;
  if (df >= 1) {
    chi2 = 0;
    for (let i = 0; i < rows.length; i++) {
      for (let j = 0; j < cols.length; j++) {
        const e = expected[i][j];
        const d = matrix[i][j] - e;
        chi2 += (d * d) / e; // e > 0 always: labels only exist where observed
      }
    }
    p = 1 - chi2Cdf(chi2, df);
  }
  return { rows, cols, matrix, rowTotals, colTotals, total, expected, chi2, df, p };
}

// cooccurrence(labelSets) → {labels, matrix}; labelSets: array of label arrays
// (one per unit). Set semantics within a unit. matrix[i][j] = #units containing
// both labels; diagonal = #units containing the label.
export function cooccurrence(labelSets) {
  if (!Array.isArray(labelSets)) throw bad("cooccurrence requires an array of label sets");
  const labelSet = new Set();
  const sets = [];
  for (const ls of labelSets) {
    if (!Array.isArray(ls)) throw bad("each label set must be an array");
    const s = new Set(ls);
    sets.push(s);
    for (const l of s) labelSet.add(l);
  }
  const labels = sortLabels(labelSet);
  const index = new Map(labels.map((l, i) => [l, i]));
  const k = labels.length;
  const matrix = Array.from({ length: k }, () => new Array(k).fill(0));
  for (const s of sets) {
    const idx = [...s].map((l) => index.get(l));
    for (const a of idx) {
      for (const b of idx) matrix[a][b] += 1;
    }
  }
  return { labels, matrix };
}

// correlationMatrix(columns) → {names, matrix}. columns: array of
// {name, values: number[]} (or a plain {name: values} object). Pearson r on
// pairwise-complete finite observations; a cell is null when a pair has < 2
// complete cases or zero variance. Diagonal is 1 by convention.
export function correlationMatrix(columns) {
  let cols;
  if (Array.isArray(columns)) {
    cols = columns;
  } else if (columns && typeof columns === "object") {
    cols = Object.entries(columns).map(([name, values]) => ({ name, values }));
  } else {
    throw bad("correlationMatrix requires an array of {name, values} or a {name: values} object");
  }
  for (const c of cols) {
    if (!c || typeof c.name !== "string" || !Array.isArray(c.values)) {
      throw bad("each column must be {name: string, values: number[]}");
    }
  }
  if (cols.length === 0) {
    throw new ConcordError("E_STAT_INSUFFICIENT", "correlationMatrix needs ≥ 1 column");
  }
  const names = cols.map((c) => c.name);
  const k = cols.length;
  const matrix = Array.from({ length: k }, () => new Array(k).fill(null));
  for (let i = 0; i < k; i++) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < k; j++) {
      const a = cols[i].values;
      const b = cols[j].values;
      const m = Math.min(a.length, b.length);
      let n = 0;
      let sa = 0;
      let sb = 0;
      for (let t = 0; t < m; t++) {
        if (Number.isFinite(a[t]) && Number.isFinite(b[t])) {
          n++;
          sa += a[t];
          sb += b[t];
        }
      }
      if (n < 2) continue; // stays null
      const ma = sa / n;
      const mb = sb / n;
      let cab = 0;
      let va = 0;
      let vb = 0;
      for (let t = 0; t < m; t++) {
        if (Number.isFinite(a[t]) && Number.isFinite(b[t])) {
          const da = a[t] - ma;
          const db = b[t] - mb;
          cab += da * db;
          va += da * da;
          vb += db * db;
        }
      }
      if (va <= 0 || vb <= 0) continue; // zero variance → null
      const r = cab / Math.sqrt(va * vb);
      matrix[i][j] = r;
      matrix[j][i] = r;
    }
  }
  return { names, matrix };
}
