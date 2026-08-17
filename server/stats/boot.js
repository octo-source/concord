// Resampling and instrument-comparison inference: bootstrap CIs over units,
// McNemar's test between instrument versions, TOST equivalence on
// leave-one-coder-out Krippendorff α. All randomness from injected mulberry32.
import { ConcordError } from "../core/errors.js";
import { mulberry32 } from "../core/rng.js";
import { krippendorffAlpha } from "./agreement.js";
import { tCdf } from "./distributions.js";

function bad(message, details = {}) {
  return new ConcordError("E_STAT_INPUT", message, details);
}

function insufficient(message, details = {}) {
  return new ConcordError("E_STAT_INSUFFICIENT", message, details);
}

// Percentile with linear interpolation (R type 7) on a sorted array.
function quantileSorted(sorted, q) {
  const m = sorted.length;
  if (m === 1) return sorted[0];
  const h = (m - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, m - 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

// Unit-resampling bootstrap percentile CI.
//
// data: agreement-style rows {unitId, coder, value}. Each replicate resamples
// n unitIds with replacement and keeps ALL coders' labels for sampled units;
// duplicated draws get fresh unitIds so they count as distinct units.
// statFn(resampledRows) → number. Replicates where statFn throws a
// ConcordError (degenerate resample, e.g. a single category) or returns a
// non-finite value are dropped; at least half of B must survive.
export function bootstrapCI(data, statFn, { B = 2000, seed = 1, alpha = 0.05 } = {}) {
  if (typeof statFn !== "function") throw bad("bootstrapCI requires statFn to be a function");
  if (!Number.isInteger(B) || B < 1) throw bad("bootstrapCI requires integer B ≥ 1", { B });
  if (typeof alpha !== "number" || !(alpha > 0 && alpha < 1)) {
    throw bad("bootstrapCI requires alpha in (0, 1)", { alpha });
  }
  if (typeof seed !== "number" || !Number.isFinite(seed)) {
    throw bad("bootstrapCI requires a finite numeric seed", { seed });
  }
  if (!Array.isArray(data)) throw bad("bootstrapCI data must be an array of rows");
  // group rows by unit in first-appearance order
  const byUnit = new Map();
  for (const row of data) {
    if (!row || row.unitId === null || row.unitId === undefined) {
      throw bad("bootstrapCI rows must carry unitId");
    }
    const uid = String(row.unitId);
    if (!byUnit.has(uid)) byUnit.set(uid, []);
    byUnit.get(uid).push(row);
  }
  const unitIds = [...byUnit.keys()];
  const n = unitIds.length;
  if (n < 2) throw insufficient("bootstrapCI needs at least 2 units", { n });
  const rand = mulberry32(seed >>> 0);
  const stats = [];
  for (let b = 0; b < B; b++) {
    const rows = [];
    for (let j = 0; j < n; j++) {
      const uid = unitIds[Math.floor(rand() * n)];
      const fresh = `${j}|${uid}`;
      for (const r of byUnit.get(uid)) {
        rows.push({ unitId: fresh, coder: r.coder, value: r.value });
      }
    }
    let s;
    try {
      s = statFn(rows);
    } catch (err) {
      if (err instanceof ConcordError) continue; // degenerate resample → drop
      throw err;
    }
    if (typeof s === "number" && Number.isFinite(s)) stats.push(s);
  }
  if (stats.length < Math.max(1, Math.ceil(B / 2))) {
    throw insufficient("too many degenerate bootstrap replicates", {
      requested: B,
      valid: stats.length,
    });
  }
  stats.sort((a, b) => a - b);
  // M3: name the method so downstream reports never have to guess which
  // bootstrap variant produced the interval.
  return {
    lo: quantileSorted(stats, alpha / 2),
    hi: quantileSorted(stats, 1 - alpha / 2),
    method: "bootstrap-percentile",
  };
}

// McNemar's test between two instrument versions on the same units.
// pairs: [{a: 0|1, b: 0|1}] — correct(1)/incorrect(0) per version.
// b = #(a=1, b=0), c = #(a=0, b=1); chi2 = (b−c)²/(b+c); pExact is the
// two-sided exact binomial test on min(b,c) ~ Binomial(b+c, ½), capped at 1.
export function mcnemar(pairs) {
  if (!Array.isArray(pairs)) throw bad("mcnemar requires an array of {a, b} pairs");
  let b = 0;
  let c = 0;
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    if (!p || (p.a !== 0 && p.a !== 1) || (p.b !== 0 && p.b !== 1)) {
      throw bad("mcnemar pairs must be {a: 0|1, b: 0|1}", { row: i });
    }
    if (p.a === 1 && p.b === 0) b++;
    else if (p.a === 0 && p.b === 1) c++;
  }
  const nd = b + c;
  if (nd === 0) return { chi2: 0, pExact: 1, b, c };
  const chi2 = ((b - c) * (b - c)) / nd;
  // exact: 2 · Σ_{i=0}^{min(b,c)} C(nd, i) · 0.5^nd, in log space, capped at 1
  const kMin = Math.min(b, c);
  const lnHalfN = nd * Math.log(0.5);
  let sum = 0;
  let lnChoose = 0; // ln C(nd, 0)
  for (let i = 0; i <= kMin; i++) {
    if (i > 0) lnChoose += Math.log(nd - i + 1) - Math.log(i);
    sum += Math.exp(lnChoose + lnHalfN);
  }
  const pExact = Math.min(1, 2 * sum);
  return { chi2, pExact, b, c };
}

// TOST equivalence on leave-one-coder-out α: does removing any single coder
// move Krippendorff's α by less than `bound`?
//
// For each coder c, α_LOO(c) is computed on the data without c; the paired
// differences d_c = α_LOO(c) − α_full feed two one-sided t-tests
// (H0: |mean d| ≥ bound) with df = #coders − 1. p = max of the two one-sided
// p-values; equivalent ⇔ p < 0.05. Needs ≥ 3 coders (each LOO subset must
// itself be codable by ≥ 2 coders).
export function tostEquivalence(data, { bound, level, order } = {}) {
  if (typeof bound !== "number" || !Number.isFinite(bound) || bound <= 0) {
    throw bad("tostEquivalence requires a positive equivalence bound", { bound });
  }
  if (!Array.isArray(data)) throw bad("tostEquivalence data must be an array of rows");
  const coders = [];
  for (const row of data) {
    if (row && row.coder !== null && row.coder !== undefined) {
      const cid = String(row.coder);
      if (!coders.includes(cid)) coders.push(cid);
    }
  }
  if (coders.length < 3) {
    throw insufficient("tostEquivalence needs at least 3 coders", { coders: coders.length });
  }
  const alphaFull = krippendorffAlpha(data, { level, order });
  const alphaLOO = coders.map((cid) =>
    krippendorffAlpha(
      data.filter((r) => String(r.coder) !== cid),
      { level, order },
    ),
  );
  const m = coders.length;
  const diffs = alphaLOO.map((a) => a - alphaFull);
  const dbar = diffs.reduce((a, b) => a + b, 0) / m;
  const varD = diffs.reduce((a, d) => a + (d - dbar) * (d - dbar), 0) / (m - 1);
  const se = Math.sqrt(varD / m);
  let p;
  if (se === 0) {
    p = Math.abs(dbar) < bound ? 0 : 1;
  } else {
    const df = m - 1;
    const p1 = 1 - tCdf((dbar + bound) / se, df); // H0: mean d ≤ −bound
    const p2 = tCdf((dbar - bound) / se, df); //     H0: mean d ≥ +bound
    p = Math.max(p1, p2);
  }
  return { p, equivalent: p < 0.05, alphaLOO };
}
