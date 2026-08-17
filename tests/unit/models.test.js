// Golden tests for models.js (OLS / logit), distributions.js, descriptives.js.
import test from "node:test";
import assert from "node:assert/strict";
import { ols, logit } from "../../server/stats/models.js";
import { normQuantile, chi2Cdf, tCdf, bhQValues } from "../../server/stats/distributions.js";
import {
  crosstab,
  cooccurrence,
  correlationMatrix,
  timeTrend,
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
  assert.ok(Math.abs(fit.coef[2] - -1.5) < EPS);
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

test("I3: tiny-scale covariate (≈1e-8) is NOT singular; coefficients scale-equivariant", () => {
  // Scale s = 2⁻²⁷ ≈ 7.45e-9 (a power of two, so x·s is EXACT in binary
  // floating point and the two fits are arithmetically identical up to the
  // column scaling — any drift beyond ~1e-12 relative is a solver bug).
  // OLS equivariance: replacing x by s·x multiplies slope and its SE by 1/s
  // and leaves the intercept untouched.
  const s = 2 ** -27;
  const rand = mulberry32(41);
  const Xbig = [];
  const Xsmall = [];
  const y = [];
  for (let i = 0; i < 40; i++) {
    const x = i + rand(); // spread, order ~40
    Xbig.push([x]);
    Xsmall.push([x * s]);
    y.push(5 + 2 * x + (rand() - 0.5)); // noisy so SEs are nonzero
  }
  const fitSmall = ols(y, Xsmall); // old absolute pivot tol 1e-12 threw E_STAT_DEGENERATE here
  const fitBig = ols(y, Xbig);
  assert.ok(Math.abs(fitSmall.coef[0] - fitBig.coef[0]) < 1e-9 * Math.abs(fitBig.coef[0]));
  assert.ok(
    Math.abs(fitSmall.coef[1] * s - fitBig.coef[1]) < 1e-9 * Math.abs(fitBig.coef[1]),
    `slope ${fitSmall.coef[1] * s} vs ${fitBig.coef[1]}`,
  );
  assert.ok(Math.abs(fitSmall.seHC1[0] - fitBig.seHC1[0]) < 1e-9 * fitBig.seHC1[0]);
  assert.ok(Math.abs(fitSmall.seHC1[1] * s - fitBig.seHC1[1]) < 1e-9 * fitBig.seHC1[1]);
});

test("I3: exact-duplicate columns still throw E_STAT_DEGENERATE", () => {
  const X = [];
  const y = [];
  const rand = mulberry32(17);
  for (let i = 0; i < 10; i++) {
    const v = rand();
    X.push([v, v]); // identical covariates
    y.push(1 + v + rand());
  }
  assertThrowsCode(() => ols(y, X), "E_STAT_DEGENERATE");
  // constant covariate (collinear with intercept) still degenerate too
  assertThrowsCode(() => ols([1, 2, 3], [[1], [1], [1]]), "E_STAT_DEGENERATE");
});

test("I4: HC1 sandwich golden with k=1 — exact hand-derived fractions, 1e-9", () => {
  // x = [0,1,2,3,4], y = [0,2,1,3,5], n = 5, p = 2.
  //   X'X = [[5,10],[10,30]], det = 50 → (X'X)⁻¹ = [[3/5,−1/5],[−1/5,1/10]]
  //   X'y = [11, 33] → β̂ = [0, 11/10]  (0.6·11−0.2·33 = 0; −0.2·11+0.1·33 = 1.1)
  //   e = y − 1.1x = [0, 9/10, −12/10, −3/10, 6/10]
  //   e² = [0, 81, 144, 9, 36]/100
  //   meat M = Σ eᵢ²·[1 xᵢ; xᵢ xᵢ²]:
  //     M11 = 270/100 = 27/10
  //     M12 = (81 + 2·144 + 3·9 + 4·36)/100 = 540/100 = 27/5
  //     M22 = (81 + 4·144 + 9·9 + 16·36)/100 = 1314/100 = 657/50
  //   A⁻¹M = [[27/50, 153/250], [0, 117/500]]
  //   A⁻¹MA⁻¹ = [[126/625, −117/2500], [−117/2500, 117/5000]]
  //   HC1 factor n/(n−p) = 5/3:
  //     V11 = 126/625 · 5/3 = 42/125,  V22 = 117/5000 · 5/3 = 39/1000
  //   seHC1 = [√(42/125), √(39/1000)]
  // A factor change to n/(n−1) = 5/4 gives V11 = 63/250 — se off by √(3/4)
  // ≈ 13%, so the 1e-9 assertion below fails loudly on any factor drift.
  const y = [0, 2, 1, 3, 5];
  const X = [[0], [1], [2], [3], [4]];
  const fit = ols(y, X);
  assert.ok(Math.abs(fit.coef[0] - 0) < 1e-9);
  assert.ok(Math.abs(fit.coef[1] - 1.1) < 1e-9);
  assert.ok(Math.abs(fit.seHC1[0] - Math.sqrt(42 / 125)) < 1e-9, `se0 ${fit.seHC1[0]}`);
  assert.ok(Math.abs(fit.seHC1[1] - Math.sqrt(39 / 1000)) < 1e-9, `se1 ${fit.seHC1[1]}`);
});

test("M6: ols r2 is null when y is constant (R² undefined, not 1)", () => {
  const fit = ols([3, 3, 3, 3], [[1], [2], [3], [4]]);
  assert.ok(Math.abs(fit.coef[0] - 3) < EPS);
  assert.ok(Math.abs(fit.coef[1] - 0) < EPS);
  assert.equal(fit.r2, null);
});

test("ols input validation", () => {
  assertThrowsCode(() => ols([1, 2], [[1]]), "E_STAT_INPUT"); // length mismatch
  assertThrowsCode(() => ols([1, 2], [[1], [2, 3]]), "E_STAT_INPUT"); // ragged X
  assertThrowsCode(() => ols([1, NaN], [[1], [2]]), "E_STAT_INPUT"); // non-finite y
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
  for (let i = 0; i < 100; i++) {
    X.push([0]);
    y.push(i < 30 ? 1 : 0);
  }
  for (let i = 0; i < 100; i++) {
    X.push([1]);
    y.push(i < 60 ? 1 : 0);
  }
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
  assert.ok(Math.abs(normQuantile(0.025) - -1.959964) < 1e-5);
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

test("I1: chi2Cdf at huge df — (1e6, 1e6) ≈ 0.50019, not the truncated 0.2607", () => {
  // P(χ²_df ≤ df) sits just above 1/2 (median < mean). Cornish–Fisher with
  // skewness γ = √(8/df): P ≈ Φ(0) + φ(0)·γ/6 = 0.5 + 0.39894·√(8/1e6)/6
  // = 0.5001881 — matches R's pchisq(1e6, 1e6) = 0.5001881. The reviewer
  // measured 0.2607 from the silently truncated 500-term series.
  assert.ok(Math.abs(chi2Cdf(1e6, 1e6) - 0.50019) < 1e-4, `got ${chi2Cdf(1e6, 1e6)}`);
});

test("I1: chi2Cdf df=50,000 at x=df agrees with the Wilson–Hilferty reference", () => {
  // WH: P(χ²_df ≤ x) ≈ Φ(((x/df)^⅓ − (1 − 2/(9df))) / √(2/(9df))).
  // Tolerance reasoning: WH absolute error near the median is O(1/df) ≈ 2e-5
  // at df = 50,000 (third-order Edgeworth residual after the cube-root
  // normalization absorbs the skewness term). Assert to 2e-4 — 10× headroom
  // over the approximation error, while a truncated series (off by ~0.4) or a
  // sign error in the skew correction (off by ~1.7e-3) would still fail.
  const df = 50000;
  const z = (Math.cbrt(df / df) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df));
  // Φ(z) for z ≥ 0 via the χ²₁ identity P(|Z| ≤ z) = chi2Cdf(z², 1)
  const wh = 0.5 + 0.5 * chi2Cdf(z * z, 1);
  assert.ok(Math.abs(chi2Cdf(df, df) - wh) < 2e-4, `got ${chi2Cdf(df, df)} want ≈${wh}`);
});

test("I1: chi2Cdf small-df golden values stay exact after the iteration fix", () => {
  assert.ok(Math.abs(chi2Cdf(3.841459, 1) - 0.95) < 1e-5);
  assert.ok(Math.abs(chi2Cdf(5.991465, 2) - 0.95) < 1e-5);
});

test("tCdf golden values", () => {
  assert.ok(Math.abs(tCdf(0, 10) - 0.5) < 1e-12);
  assert.ok(Math.abs(tCdf(1.812461, 10) - 0.95) < 1e-5); // t_{0.95,10}
  assert.ok(Math.abs(tCdf(-1.812461, 10) - 0.05) < 1e-5);
  assert.ok(Math.abs(tCdf(2.228139, 10) - 0.975) < 1e-5); // t_{0.975,10}
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

test("M8: crosstab reports minExpected (smallest expected cell) for small-n warnings", () => {
  const units = [];
  const push = (dept, label, k) => {
    for (let i = 0; i < k; i++) units.push({ dept, label });
  };
  push("O", "n", 40);
  push("S", "y", 30);
  push("S", "n", 10);
  push("O", "y", 20);
  // expected: O row 60·50/100 = 30 each; S row 40·50/100 = 20 each → min 20
  const t = crosstab(units, "dept", "label");
  assert.ok(Math.abs(t.minExpected - 20) < EPS);
  // skewed table: expected min = 5·10/100 = 0.5
  const units2 = [];
  const push2 = (a, b, k) => {
    for (let i = 0; i < k; i++) units2.push({ a, b });
  };
  push2("r1", "c1", 85);
  push2("r1", "c2", 5);
  push2("r2", "c1", 10);
  const t2 = crosstab(units2, "a", "b");
  assert.ok(Math.abs(t2.minExpected - (10 * 5) / 100) < EPS);
});

// ---------- R3: timeTrend ----------

test("R3: timeTrend day buckets — sorted, counts, means", () => {
  const rows = [
    { at: "2026-06-05", score: 2 },
    { at: "2026-06-03", score: 1 },
    { at: "2026-06-05", score: 4 },
    { at: "2026-06-03T23:59:59Z", score: 5 },
  ];
  const r = timeTrend(rows, { dateKey: "at", valueKey: "score", bucket: "day" });
  assert.equal(r.issues, 0);
  assert.deepEqual(r.buckets, [
    { bucket: "2026-06-03", n: 2, mean: 3 },
    { bucket: "2026-06-05", n: 2, mean: 3 },
  ]);
});

test("R3: timeTrend ISO weeks — year-boundary goldens", () => {
  // ISO 8601: 2021-01-01 (Fri) belongs to 2020-W53; 2024-12-30 (Mon) to 2025-W01.
  const rows = [
    { at: "2021-01-01" },
    { at: "2024-12-30" },
    { at: "2024-12-29" }, // Sunday → still 2024-W52
  ];
  const r = timeTrend(rows, { dateKey: "at", bucket: "week" });
  assert.deepEqual(
    r.buckets.map((b) => b.bucket),
    ["2020-W53", "2024-W52", "2025-W01"],
  );
  for (const b of r.buckets) {
    assert.equal(b.n, 1);
    assert.ok(!("mean" in b)); // no valueKey → no mean field
  }
});

test("R3: timeTrend month buckets and invalid dates → issues count, not thrown", () => {
  const rows = [
    { at: "2026-01-15", v: 1 },
    { at: "2026-01-20", v: 3 },
    { at: "not a date", v: 7 }, // issue
    { at: null, v: 7 }, // issue
    { v: 7 }, // missing date → issue
    { at: "2026-02-01", v: "n/a" }, // valid date, non-numeric value → counts in n, not mean
    { at: "2026-02-02", v: 10 },
  ];
  const r = timeTrend(rows, { dateKey: "at", valueKey: "v", bucket: "month" });
  assert.equal(r.issues, 3);
  assert.deepEqual(r.buckets, [
    { bucket: "2026-01", n: 2, mean: 2 },
    { bucket: "2026-02", n: 2, mean: 10 },
  ]);
});

test("R3: timeTrend validation and empty input", () => {
  assertThrowsCode(() => timeTrend("nope", { dateKey: "at", bucket: "day" }), "E_STAT_INPUT");
  assertThrowsCode(() => timeTrend([], { dateKey: "at", bucket: "hour" }), "E_STAT_INPUT");
  assertThrowsCode(() => timeTrend([], { bucket: "day" }), "E_STAT_INPUT");
  const r = timeTrend([], { dateKey: "at", bucket: "day" });
  assert.deepEqual(r, { buckets: [], issues: 0 });
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
  assert.ok(Math.abs(matrix[0][2] - -1) < EPS);
  assert.ok(Math.abs(matrix[0][3] - -1 / Math.sqrt(5)) < EPS);
  assert.ok(Math.abs(matrix[3][0] - matrix[0][3]) < EPS); // symmetric
});

test("correlationMatrix: pairwise-complete on non-finite, null when degenerate", () => {
  const cols = [
    { name: "a", values: [1, 2, 3, NaN] },
    { name: "b", values: [2, 4, 6, 100] }, // pairwise with a → first 3 only → r=1
    { name: "c", values: [5, 5, 5, 5] }, // zero variance → null vs others
  ];
  const { matrix } = correlationMatrix(cols);
  assert.ok(Math.abs(matrix[0][1] - 1) < EPS);
  assert.equal(matrix[0][2], null);
  assert.equal(matrix[2][2], 1); // self-correlation stays 1 by convention
});
