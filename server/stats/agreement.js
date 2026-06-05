// Intercoder agreement statistics, all built on the coincidence-matrix
// formulation so any number of coders and missing data (absent rows) work.
//
// data: array of {unitId, coder, value}. A missing coding is simply an absent
// row. Values are category labels (string or number); category identity is
// String(value), so 1 and "1" are the same category (CSV-sourced data).
//
// Edge policy (instrument-grade — never NaN):
//   E_STAT_INPUT        malformed rows, bad options, wrong #coders
//   E_STAT_INSUFFICIENT no pairable units / empty data
//   E_STAT_DEGENERATE   statistic undefined (e.g. a single category)
import { ConcordError } from "../core/errors.js";

function bad(message, details = {}) {
  return new ConcordError("E_STAT_INPUT", message, details);
}

function insufficient(message, details = {}) {
  return new ConcordError("E_STAT_INSUFFICIENT", message, details);
}

function degenerate(message, details = {}) {
  return new ConcordError("E_STAT_DEGENERATE", message, details);
}

// Deterministic label sort: numeric ascending when every category key parses
// as a finite number, else plain UTF-16 string order.
function sortKeys(keys) {
  const arr = [...keys];
  const nums = arr.map(Number);
  if (arr.length > 0 && nums.every((n) => Number.isFinite(n))) {
    return arr.slice().sort((a, b) => Number(a) - Number(b));
  }
  return arr.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// Validate rows and group them: Map unitId → Map coder → {key, value}.
// Duplicate (unitId, coder) rows are a data bug → E_STAT_INPUT.
function groupByUnit(data) {
  if (!Array.isArray(data)) throw bad("agreement data must be an array of rows");
  const units = new Map();
  const coders = new Set();
  const firstSeen = new Map(); // category key → representative original value
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (!row || typeof row !== "object") throw bad("row must be an object", { row: i });
    const { unitId, coder, value } = row;
    if (unitId === null || unitId === undefined || unitId === "") {
      throw bad("row missing unitId", { row: i });
    }
    if (coder === null || coder === undefined || coder === "") {
      throw bad("row missing coder", { row: i });
    }
    if (value === null || value === undefined) {
      throw bad("row has null value — missing codings must be absent rows", { row: i });
    }
    const uid = String(unitId);
    const cid = String(coder);
    let m = units.get(uid);
    if (!m) {
      m = new Map();
      units.set(uid, m);
    }
    if (m.has(cid)) {
      throw bad("duplicate coding for (unitId, coder)", { unitId: uid, coder: cid });
    }
    const key = String(value);
    if (!firstSeen.has(key)) firstSeen.set(key, value);
    m.set(cid, { key, value });
    coders.add(cid);
  }
  return { units, coders: [...coders], firstSeen };
}

// Krippendorff coincidence matrix over pairable units (m ≥ 2): each ordered
// pair of values from different coders in a unit contributes 1/(m−1).
// Returns {keys, index, o, margins, n} — keys sorted deterministically.
function coincidenceMatrix(units) {
  const keySet = new Set();
  const pairable = [];
  for (const m of units.values()) {
    if (m.size >= 2) {
      const vals = [...m.values()].map((v) => v.key);
      pairable.push(vals);
      for (const k of vals) keySet.add(k);
    }
  }
  if (pairable.length === 0) {
    throw insufficient("no unit was coded by two or more coders");
  }
  const keys = sortKeys(keySet);
  const index = new Map(keys.map((k, i) => [k, i]));
  const k = keys.length;
  const o = Array.from({ length: k }, () => new Array(k).fill(0));
  for (const vals of pairable) {
    const m = vals.length;
    const w = 1 / (m - 1);
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) {
        if (i === j) continue;
        o[index.get(vals[i])][index.get(vals[j])] += w;
      }
    }
  }
  const margins = o.map((row) => row.reduce((a, b) => a + b, 0));
  const n = margins.reduce((a, b) => a + b, 0);
  return { keys, index, o, margins, n };
}

// Average pairwise agreement within units (the AC1 "po"): for each unit with
// m ≥ 2 codings, Σ_q r_q(r_q−1) / (m(m−1)), averaged over such units.
function observedAgreement(units) {
  let sum = 0;
  let count = 0;
  for (const m of units.values()) {
    if (m.size < 2) continue;
    const tally = new Map();
    for (const v of m.values()) tally.set(v.key, (tally.get(v.key) || 0) + 1);
    const mu = m.size;
    let agree = 0;
    for (const r of tally.values()) agree += r * (r - 1);
    sum += agree / (mu * (mu - 1));
    count++;
  }
  if (count === 0) throw insufficient("no unit was coded by two or more coders");
  return { po: sum / count, units: count };
}

// ---------- exports ----------

// Average pairwise percent agreement across units (any #coders, missing OK).
export function percentAgreement(data) {
  const { units } = groupByUnit(data);
  return observedAgreement(units).po;
}

// Cohen's κ for exactly two coders; optional ordinal weighting
// ({weighted: "linear" | "quadratic"}) over deterministically sorted categories.
export function cohenKappa(data, { weighted } = {}) {
  if (weighted !== undefined && weighted !== "linear" && weighted !== "quadratic") {
    throw bad('cohenKappa weighted must be "linear" or "quadratic"', { weighted });
  }
  const { units, coders } = groupByUnit(data);
  if (coders.length !== 2) {
    throw bad("cohenKappa requires exactly 2 coders in the data", { coders });
  }
  const [A, B] = coders;
  const pairs = [];
  const keySet = new Set();
  for (const m of units.values()) {
    if (m.has(A) && m.has(B)) {
      const a = m.get(A).key;
      const b = m.get(B).key;
      pairs.push([a, b]);
      keySet.add(a);
      keySet.add(b);
    }
  }
  if (pairs.length === 0) throw insufficient("no unit was coded by both coders");
  const keys = sortKeys(keySet);
  const k = keys.length;
  if (k < 2) {
    throw degenerate("kappa is undefined with a single category", { category: keys[0] });
  }
  const index = new Map(keys.map((key, i) => [key, i]));
  const n = pairs.length;
  const joint = Array.from({ length: k }, () => new Array(k).fill(0));
  for (const [a, b] of pairs) joint[index.get(a)][index.get(b)] += 1 / n;
  const pA = joint.map((row) => row.reduce((x, y) => x + y, 0));
  const pB = keys.map((_, j) => joint.reduce((x, row) => x + row[j], 0));
  const weight = (i, j) => {
    if (!weighted) return i === j ? 1 : 0;
    const d = Math.abs(i - j) / (k - 1);
    return weighted === "linear" ? 1 - d : 1 - d * d;
  };
  let po = 0;
  let pe = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const w = weight(i, j);
      if (w === 0) continue;
      po += w * joint[i][j];
      pe += w * pA[i] * pB[j];
    }
  }
  if (1 - pe <= 1e-12) {
    throw degenerate("kappa is undefined: expected agreement is 1", { pe });
  }
  return (po - pe) / (1 - pe);
}

// Krippendorff's α via the coincidence matrix. level: "nominal" | "ordinal" |
// "interval". Ordinal uses Krippendorff's rank metric on coincidence margins;
// interval requires numeric category values.
export function krippendorffAlpha(data, { level } = {}) {
  if (level !== "nominal" && level !== "ordinal" && level !== "interval") {
    throw bad('krippendorffAlpha level must be "nominal", "ordinal" or "interval"', { level });
  }
  const { units } = groupByUnit(data);
  const { keys, o, margins, n } = coincidenceMatrix(units);
  const k = keys.length;
  if (k < 2) {
    throw degenerate("alpha is undefined with a single category", { category: keys[0] });
  }
  if (n < 2) throw insufficient("need at least two pairable values");
  // squared distance metric δ²(c, k) per measurement level
  let delta2;
  if (level === "nominal") {
    delta2 = (i, j) => (i === j ? 0 : 1);
  } else if (level === "interval") {
    const vals = keys.map(Number);
    if (!vals.every((v) => Number.isFinite(v))) {
      throw bad("interval alpha requires numeric category values", { keys });
    }
    delta2 = (i, j) => (vals[i] - vals[j]) ** 2;
  } else {
    // ordinal: δ²(c,k) = (Σ_{g=c..k} n_g − (n_c + n_k)/2)² over sorted ranks
    delta2 = (i, j) => {
      if (i === j) return 0;
      const lo = Math.min(i, j);
      const hi = Math.max(i, j);
      let s = 0;
      for (let g = lo; g <= hi; g++) s += margins[g];
      s -= (margins[lo] + margins[hi]) / 2;
      return s * s;
    };
  }
  let Do = 0;
  let De = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      if (i === j) continue;
      const d2 = delta2(i, j);
      Do += o[i][j] * d2;
      De += margins[i] * margins[j] * d2;
    }
  }
  Do /= n;
  De /= n * (n - 1);
  if (De <= 0) {
    throw degenerate("alpha is undefined: no expected disagreement", { keys });
  }
  return 1 - Do / De;
}

// Gwet's AC1 (chance-agreement-robust). po as in percentAgreement; chance
// pe = (1/(Q−1)) Σ_q π̄_q(1−π̄_q) with π̄_q the mean within-unit share of q.
export function gwetAC1(data) {
  const { units } = groupByUnit(data);
  const { po } = observedAgreement(units);
  // π̄ over all units with at least one coding
  const keySet = new Set();
  const shares = new Map();
  let nUnits = 0;
  for (const m of units.values()) {
    if (m.size < 1) continue;
    nUnits++;
    const tally = new Map();
    for (const v of m.values()) tally.set(v.key, (tally.get(v.key) || 0) + 1);
    for (const [key, r] of tally) {
      keySet.add(key);
      shares.set(key, (shares.get(key) || 0) + r / m.size);
    }
  }
  const Q = keySet.size;
  if (Q < 2) {
    throw degenerate("AC1 is undefined with a single category", { category: [...keySet][0] });
  }
  let pe = 0;
  for (const key of keySet) {
    const piBar = (shares.get(key) || 0) / nUnits;
    pe += piBar * (1 - piBar);
  }
  pe /= Q - 1;
  return (po - pe) / (1 - pe);
}

// Per-class precision/recall/F1 against a designated gold coder. Every other
// coder's coding on a gold-coded unit yields one (gold, predicted) pair.
export function perClass(data, goldCoder) {
  if (goldCoder === null || goldCoder === undefined || goldCoder === "") {
    throw bad("perClass requires a goldCoder");
  }
  const { units, coders, firstSeen } = groupByUnit(data);
  const gid = String(goldCoder);
  if (!coders.includes(gid)) {
    throw bad("goldCoder does not appear in the data", { goldCoder: gid });
  }
  const pairs = []; // [goldKey, predKey]
  for (const m of units.values()) {
    if (!m.has(gid)) continue;
    const g = m.get(gid).key;
    for (const [coder, v] of m) {
      if (coder === gid) continue;
      pairs.push([g, v.key]);
    }
  }
  if (pairs.length === 0) {
    throw insufficient("no unit has both a gold coding and another coder's coding");
  }
  const keySet = new Set();
  for (const [g, p] of pairs) {
    keySet.add(g);
    keySet.add(p);
  }
  const keys = sortKeys(keySet);
  return keys.map((key) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let support = 0;
    for (const [g, p] of pairs) {
      if (g === key && p === key) tp++;
      else if (g !== key && p === key) fp++;
      else if (g === key && p !== key) fn++;
      if (g === key) support++;
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    return { label: firstSeen.get(key), precision, recall, f1, support };
  });
}

// Confusion matrix between two coders over jointly coded units.
// Rows = coderA's categories, cols = coderB's, deterministically sorted.
export function confusion(data, coderA, coderB) {
  if (!coderA || !coderB) throw bad("confusion requires two coder ids");
  const { units, coders, firstSeen } = groupByUnit(data);
  const a = String(coderA);
  const b = String(coderB);
  if (!coders.includes(a)) throw bad("coderA does not appear in the data", { coderA: a });
  if (!coders.includes(b)) throw bad("coderB does not appear in the data", { coderB: b });
  const pairs = [];
  const keySet = new Set();
  for (const m of units.values()) {
    if (m.has(a) && m.has(b)) {
      const ka = m.get(a).key;
      const kb = m.get(b).key;
      pairs.push([ka, kb]);
      keySet.add(ka);
      keySet.add(kb);
    }
  }
  if (pairs.length === 0) throw insufficient("no unit was coded by both coders");
  const keys = sortKeys(keySet);
  const index = new Map(keys.map((key, i) => [key, i]));
  const matrix = Array.from({ length: keys.length }, () => new Array(keys.length).fill(0));
  for (const [ka, kb] of pairs) matrix[index.get(ka)][index.get(kb)] += 1;
  return { labels: keys.map((key) => firstSeen.get(key)), matrix };
}
