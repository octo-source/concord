// Golden tests for models.js (OLS / logit), distributions.js, descriptives.js.
import test from "node:test";
import assert from "node:assert/strict";
import { ols, logit } from "../../server/stats/models.js";
import {
  normQuantile,
  chi2Cdf,
  tCdf,
  bhQValues,
} from "../../server/stats/distributions.js";
import {
  crosstab,
  cooccurrence,
  correlationMatrix,
} from "../../server/stats/descriptives.js";
import { mulberry32 } from "../../server/core/rng.js";
import { ConcordError } from "../../server/core/errors.js";

const EPS = 1e-9;

function assertThrowsCode(fn, code) {
  assert.throws(fn, (err) => err instanceof ConcordError && err.code === code);
}

// ---------- models.ols ----------

test("ols recovers exact coefficients on noiseless data (y = 2 + 3x − 1.5z, n=50)", () => {
  const rand = mulberry32(7);
  const X = [];
  const y = [];
  for (let i = 0; i < 50; i++) {
    const x = rand();
    const z = rand();
    X.push([x, z]);
    y.push(2 + 3 * x - 1.5 * z);
  }
  const fit = ols(y, X);
  assert.ok(Math.abs(fit.coef[0] - 2) < EPS);
  assert.ok(Math.abs(fit.coef[1] - 3) < EPS);
  assert.ok(Math.abs(fit.coef[2] - (-1.5)) < EPS);
  assert.ok(fit.r2 > 1 - EPS);
  for (const se of fit.seHC1) assert.ok(se >= 0 && se < 1e-6);
});

test("ols: intercept-only regression returns the mean", () => {
  const fit = ols([1, 2, 3, 4], [[], [], [], []]);
  assert.ok(Math.abs(fit.coef[0] - 2.5) < EPS);
  assert.equal(fit.coef.length, 1);
});

test("ols: HC1 sandwich SE matches hand formula on a tiny case", () => {
  // y on intercept only: residuals e_i = y_i − ȳ. HC1 var = (X'X)^-1 Σe² (X'X)^-1 · n/(n−1)
  // = (1/n²)Σe² · n/(n−1) = Σe²/(n(n−1)) — the classic sample-mean variance.
  const y = [1, 2, 3, 6];
  const n = 4;
  const ybar = 3;
  const sumE2 = (1 - 3) ** 2 + (2 - 3) ** 2 + 0 + (6 - 3) ** 2; // 4+1+0+9 = 14
  const want = Math.sqrt(sumE2 / (n * (n - 1)));
  const fit = ols(y, [[], [], [], []]);
  assert.ok(Math.abs(fit.seHC1[0] - want) < EPS);
});

test("ols input validation", () => {
  assertThrowsCode(() => ols([1, 2], [[1]]), "E_STAT_INPUT");           // length mismatch
  assertThrowsCode(() => ols([1, 2], [[1], [2, 3]]), "E_STAT_INPUT");   // ragged X
  assertThrowsCode(() => ols([1, NaN], [[1], [2]]), "E_STAT_INPUT");    // non-finite y
  assertThrowsCode(() => ols([1, 2], [[1], [2]]), "E_STAT_INSUFFICIENT"); // n ≤ p
  assertThrowsCode(() => ols([1, 2, 3], [[1], [1], [1]]), "E_STAT_DEGENERATE"); // collinear (x ≡ const)
});

// ---------- models.logit ----------

test("logit converges with correct sign and |z| > 5 on strongly separated synthetic (n=500)", () => {
  const rand = mulberry32(99);
  const X = [];
  const y = [];
  for (let i = 0; i < 500; i++) {
    const x = 2 * rand() - 1;
    const p = 1 / (1 + Math.exp(-(0.5 + 3 * x)));
    X.push([x]);
    y.push(rand() < p ? 1 : 0);
  }
  const fit = logit(y, X);
  assert.equal(fit.converged, true);
  assert.ok(fit.coef[1] > 0);
  const z = fit.coef[1] / fit.seHC1[1];
  assert.ok(Math.abs(z) > 5, `|z| = ${Math.abs(z)} should exceed 5`);
  // loose recovery: truth 3, n=500 → estimate should land in a wide band
  assert.ok(fit.coef[1] > 1.5 && fit.coef[1] < 5);
});

test("logit on complete separation: finite coefs, converged=false", () => {
  const X = [];
  const y = [];
  for (let i = 0; i < 40; i++) {
    const x = i < 20 ? -1 - i * 0.05 : 1 + (i - 20) * 0.05;
    X.push([x]);
    y.push(x > 0 ? 1 : 0);
  }
  const fit = logit(y, X);
  assert.equal(fit.converged, false);
  for (const c of fit.coef) assert.ok(Number.isFinite(c));
  for (const se of fit.seHC1) assert.ok(Number.isFinite(se));
});

test("logit validation: y must be 0/1", () => {
  assertThrowsCode(() => logit([0, 1, 2], [[1], [2], [3]]), "E_STAT_INPUT");
});

test("logit matches closed form on saturated binary-x model", () => {
  // x ∈ {0,1}: MLE slope = logit(p̂1) − logit(p̂0), intercept = logit(p̂0).
  // counts: x=0 → 30 ones / 100; x=1 → 60 ones / 100.
  const X = [];
  const y = [];
  for (let i = 0; i < 100; i++) { X.push([0]); y.push(i < 30 ? 1 : 0); }
  for (let i = 0; i < 100; i++) { X.push([1]); y.push(i < 60 ? 1 : 0); }
  const fit = logit(y, X);
  const b0 = Math.log(0.3 / 0.7);
  const b1 = Math.log(0.6 / 0.4) - b0;
  assert.equal(fit.converged, true);
  assert.ok(Math.abs(fit.coef[0] - b0) < 1e-7);
  assert.ok(Math.abs(fit.coef[1] - b1) < 1e-7);
});

// ---------- distributions ----------

test("normQuantile golden values", () => {
  assert.ok(Math.abs(normQuantile(0.975) - 1.959964) < 1e-5);
  assert.ok(Math.abs(normQuantile(0.025) - (-1.959964)) < 1e-5);
  assert.ok(Math.abs(normQuantile(0.5)) < 1e-12);
  assert.ok(Math.abs(normQuantile(0.995) - 2.5758293) < 1e-5);
  assertThrowsCode(() => normQuantile(0), "E_STAT_INPUT");
  assertThrowsCode(() => normQuantile(1), "E_STAT_INPUT");
});

test("chi2Cdf golden values", () => {
  assert.ok(Math.abs(chi2Cdf(3.841459, 1) - 0.95) < 1e-5);
  assert.ok(Math.abs(chi2Cdf(5.991465, 2) - 0.95) < 1e-5);
  assert.ok(Math.abs(chi2Cdf(0, 1) - 0) < 1e-12);
  assert.ok(chi2Cdf(1000, 1) > 1 - 1e-12);
  assertThrowsCode(() => chi2Cdf(-1, 1), "E_STAT_INPUT");
  assertThrowsCode(() => chi2Cdf(1, 0), "E_STAT_INPUT");
});

test("tCdf golden values", () => {
  assert.ok(Math.abs(tCdf(0, 10) - 0.5) < 1e-12);
  assert.ok(Math.abs(tCdf(1.812461, 10) - 0.95) < 1e-5);   // t_{0.95,10}
  assert.ok(Math.abs(tCdf(-1.812461, 10) - 0.05) < 1e-5);
  assert.ok(Math.abs(tCdf(2.228139, 10) - 0.975) < 1e-5);  // t_{0.975,10}
  // large df → normal: tCdf(1.959964, 1e6) ≈ 0.975
  assert.ok(Math.abs(tCdf(1.959964, 1e6) - 0.975) < 1e-4);
  assertThrowsCode(() => tCdf(0, 0), "E_STAT_INPUT");
});

test("bhQValues golden: [0.01,0.02,0.03,0.04] → all 0.04", () => {
  assert.deepEqual(bhQValues([0.01, 0.02, 0.03, 0.04]), [0.04, 0.04, 0.04, 0.04]);
});

test("bhQValues: step-up monotone min, order preserved, capped at 1", () => {
  // sorted [0.005, 0.04, 0.04]: raw m·p/rank = [0.015, 0.06, 0.04] → from right [0.015, 0.04, 0.04]
  const q = bhQValues([0.04, 0.005, 0.04]);
  assert.ok(Math.abs(q[0] - 0.04) < EPS);
  assert.ok(Math.abs(q[1] - 0.015) < EPS);
  assert.ok(Math.abs(q[2] - 0.04) < EPS);
  assert.deepEqual(bhQValues([]), []);
  assert.deepEqual(bhQValues([1]), [1]);
  assertThrowsCode(() => bhQValues([0.5, 1.2]), "E_STAT_INPUT");
  assertThrowsCode(() => bhQValues([-0.1]), "E_STAT_INPUT");
});

// ---------- descriptives ----------

test("crosstab golden: 2x2 with chi2 = 50/3", () => {
  // S-y=30, S-n=10, O-y=20, O-n=40. Expected: S-y 20, S-n 20, O-y 30, O-n 30.
  // chi2 = 100/20 + 100/20 + 100/30 + 100/30 = 50/3.
  const units = [];
  const push = (dept, label, k) => {
    for (let i = 0; i < k; i++) units.push({ dept, label });
  };
  push("O", "n", 40); // insertion order ≠ sorted order on purpose
  push("S", "y", 30);
  push("S", "n", 10);
  push("O", "y", 20);
  const t = crosstab(units, "dept", "label");
  assert.deepEqual(t.rows, ["O", "S"]);
  assert.deepEqual(t.cols, ["n", "y"]);
  assert.deepEqual(t.matrix, [
    [40, 20],
    [10, 30],
  ]);
  assert.deepEqual(t.rowTotals, [60, 40]);
  assert.deepEqual(t.colTotals, [50, 50]);
  assert.equal(t.total, 100);
  assert.equal(t.df, 1);
  assert.ok(Math.abs(t.chi2 - 50 / 3) < EPS);
  assert.ok(Math.abs(t.expected[0][0] - 30) < EPS);
  assert.ok(Math.abs(t.expected[1][0] - 20) < EPS);
  assert.ok(Math.abs(t.p - (1 - chi2Cdf(50 / 3, 1))) < 1e-12);
});

test("crosstab: single row category → df 0, chi2/p null; null cells skipped", () => {
  const units = [
    { a: "x", b: "1" },
    { a: "x", b: "2" },
    { a: "x", b: null }, // skipped
    { a: undefined, b: "1" }, // skipped
  ];
  const t = crosstab(units, "a", "b");
  assert.equal(t.total, 2);
  assert.equal(t.df, 0);
  assert.equal(t.chi2, null);
  assert.equal(t.p, null);
  assertThrowsCode(() => crosstab([], "a", "b"), "E_STAT_INSUFFICIENT");
});

test("cooccurrence: counts sets containing both labels (diagonal = label count)", () => {
  const sets = [["a", "b"], ["a"], ["b", "a"], ["c"], ["a", "a"]]; // dupes within a set collapse
  const { labels, matrix } = cooccurrence(sets);
  assert.deepEqual(labels, ["a", "b", "c"]);
  assert.deepEqual(matrix, [
    [4, 2, 0],
    [2, 2, 0],
    [0, 0, 1],
  ]);
});

test("correlationMatrix golden: r(x,2x)=1, r(x,−x)=−1, r(x,w)=−1/√5", () => {
  const x = [1, 2, 3, 4];
  const cols = [
    { name: "x", values: x },
    { name: "y", values: x.map((v) => 2 * v) },
    { name: "z", values: x.map((v) => -v) },
    { name: "w", values: [1, -1, 1, -1] },
  ];
  const { names, matrix } = correlationMatrix(cols);
  assert.deepEqual(names, ["x", "y", "z", "w"]);
  assert.ok(Math.abs(matrix[0][0] - 1) < EPS);
  assert.ok(Math.abs(matrix[0][1] - 1) < EPS);
  assert.ok(Math.abs(matrix[0][2] - (-1)) < EPS);
  assert.ok(Math.abs(matrix[0][3] - (-1 / Math.sqrt(5))) < EPS);
  assert.ok(Math.abs(matrix[3][0] - matrix[0][3]) < EPS); // symmetric
});

test("correlationMatrix: pairwise-complete on non-finite, null when degenerate", () => {
  const cols = [
    { name: "a", values: [1, 2, 3, NaN] },
    { name: "b", values: [2, 4, 6, 100] }, // pairwise with a → first 3 only → r=1
    { name: "c", values: [5, 5, 5, 5] },   // zero variance → null vs others
  ];
  const { matrix } = correlationMatrix(cols);
  assert.ok(Math.abs(matrix[0][1] - 1) < EPS);
  assert.equal(matrix[0][2], null);
  assert.equal(matrix[2][2], 1); // self-correlation stays 1 by convention
});
