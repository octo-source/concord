// Golden tests for correction.js — DSL (design-based supervised learning) and PPI.
// units: [{yhat, y?, pi?, x?: number[]}]; gold rows have y AND pi.
import test from "node:test";
import assert from "node:assert/strict";
import {
  dslMean,
  dslProportion,
  dslDiff,
  dslOLS,
  dslLogit,
  ppiMean,
} from "../../server/stats/correction.js";
import { ols, logit } from "../../server/stats/models.js";
import { normQuantile } from "../../server/stats/distributions.js";
import { mulberry32 } from "../../server/core/rng.js";
import { ConcordError } from "../../server/core/errors.js";

const EPS = 1e-9;
const Z975 = normQuantile(0.975);

function assertThrowsCode(fn, code) {
  assert.throws(fn, (err) => err instanceof ConcordError && err.code === code);
}

// ---------- dslMean ----------

test("dslMean golden: Ŷ=[1,0,1,0], gold units 1,2 (π=0.5, Y=[1,1]) → est = 1.0 exactly", () => {
  // pseudo: [1 + 2(1−1), 0 + 2(1−0), 1, 0] = [1, 2, 1, 0] → mean 1.0
  const units = [
    { yhat: 1, y: 1, pi: 0.5 },
    { yhat: 0, y: 1, pi: 0.5 },
    { yhat: 1 },
    { yhat: 0 },
  ];
  const r = dslMean(units);
  assert.ok(Math.abs(r.est - 1.0) < EPS);
  // sandwich: devs [0,1,0,−1] → B = 2/4 = 0.5 → var = 0.5/4 → se = sqrt(0.125)
  assert.ok(Math.abs(r.se - Math.sqrt(0.125)) < EPS);
  assert.ok(Math.abs(r.ciLo - (1.0 - Z975 * r.se)) < 1e-12);
  assert.ok(Math.abs(r.ciHi - (1.0 + Z975 * r.se)) < 1e-12);
  // naive: mean(Ŷ)=0.5; conventional se = sqrt(sampleVar/n) = sqrt((1/3)/4)
  assert.ok(Math.abs(r.naive.est - 0.5) < EPS);
  assert.ok(Math.abs(r.naive.se - Math.sqrt(1 / 3 / 4)) < EPS);
});

test("dslMean: all-gold π=1 reduces to the gold mean exactly", () => {
  const ys = [0.2, 0.4, 0.9, 0.1, 0.6];
  const units = ys.map((y) => ({ yhat: 0, y, pi: 1 }));
  const r = dslMean(units);
  const want = ys.reduce((a, b) => a + b, 0) / ys.length;
  assert.ok(Math.abs(r.est - want) < EPS);
});

// ---------- dslProportion ----------

test("dslProportion: same estimator as dslMean on 0/1 data; naive uses Wald se", () => {
  const units = [
    { yhat: 1, y: 1, pi: 0.5 },
    { yhat: 0, y: 1, pi: 0.5 },
    { yhat: 1 },
    { yhat: 0 },
  ];
  const r = dslProportion(units);
  assert.ok(Math.abs(r.est - 1.0) < EPS);
  assert.ok(Math.abs(r.se - Math.sqrt(0.125)) < EPS);
  assert.ok(Math.abs(r.naive.est - 0.5) < EPS);
  assert.ok(Math.abs(r.naive.se - Math.sqrt(0.5 * 0.5 / 4)) < EPS); // Wald
});

test("dslProportion rejects non-binary yhat/y", () => {
  assertThrowsCode(
    () => dslProportion([{ yhat: 0.7, y: 1, pi: 0.5 }, { yhat: 0 }]),
    "E_STAT_INPUT"
  );
  assertThrowsCode(
    () => dslProportion([{ yhat: 1, y: 0.5, pi: 0.5 }, { yhat: 0 }]),
    "E_STAT_INPUT"
  );
});

// ---------- dslDiff ----------

test("dslDiff: all-gold π=1 → exact difference of gold means; naive differs", () => {
  // A: y=[1,1,0,1] mean .75, yhat all 1 → naive A mean 1
  // B: y=[0,0,1,0] mean .25, yhat all 0 → naive B mean 0
  const unitsA = [1, 1, 0, 1].map((y) => ({ yhat: 1, y, pi: 1 }));
  const unitsB = [0, 0, 1, 0].map((y) => ({ yhat: 0, y, pi: 1 }));
  const r = dslDiff(unitsA, unitsB);
  assert.ok(Math.abs(r.est - 0.5) < EPS);
  assert.ok(Math.abs(r.naive.est - 1.0) < EPS);
  // each group: devs² sum = 3(.0625)+.5625 = .75 → var = (.75/4)/4 = .046875; diff var doubles
  assert.ok(Math.abs(r.se - Math.sqrt(0.09375)) < EPS);
  assert.ok(Math.abs(r.ciLo - (r.est - Z975 * r.se)) < 1e-12);
  assert.ok(Math.abs(r.ciHi - (r.est + Z975 * r.se)) < 1e-12);
});

// ---------- ppiMean ----------

test("ppiMean classical golden: est = 2/3 + 1/2 = 7/6", () => {
  // Ŷ_all=[1,0,1,1,0,1] → mean 2/3; gold: (Y=1,Ŷ=1) → 0, (Y=1,Ŷ=0) → 1 → mean rectifier 1/2
  const units = [
    { yhat: 1, y: 1, pi: 1 / 3 },
    { yhat: 0, y: 1, pi: 1 / 3 },
    { yhat: 1 },
    { yhat: 1 },
    { yhat: 0 },
    { yhat: 1 },
  ];
  const r = ppiMean(units);
  assert.ok(Math.abs(r.est - 7 / 6) < EPS);
  // se = sqrt(var(Ŷall)/n + var(Y−Ŷ on gold)/n_gold), sample (n−1) variances:
  // var(Ŷall) = (4·(1/3)² + 2·(2/3)²)/5 = (4/9 + 8/9)/5 = 4/15
  // var(rectifier [0,1]) = 1/2 → se = sqrt(4/90 + 1/4)
  const want = Math.sqrt(4 / 15 / 6 + 0.5 / 2);
  assert.ok(Math.abs(r.se - want) < EPS);
  assert.ok(Math.abs(r.naive.est - 2 / 3) < EPS);
  assert.ok(Math.abs(r.ciLo - (r.est - Z975 * r.se)) < 1e-12);
});

test("ppiMean accepts explicit classical and numeric lambda", () => {
  const units = [
    { yhat: 1, y: 1, pi: 1 / 3 },
    { yhat: 0, y: 1, pi: 1 / 3 },
    { yhat: 1 },
    { yhat: 1 },
    { yhat: 0 },
    { yhat: 1 },
  ];
  const r1 = ppiMean(units, { lambda: "classical" });
  assert.ok(Math.abs(r1.est - 7 / 6) < EPS);
  // λ=0 → est = mean gold Y = 1
  const r0 = ppiMean(units, { lambda: 0 });
  assert.ok(Math.abs(r0.est - 1) < EPS);
  assertThrowsCode(() => ppiMean(units, { lambda: "auto" }), "E_STAT_INPUT");
});

// ---------- dslOLS ----------

test("dslOLS golden: noiseless y = 2 + 3x − 1.5z, machine bias +0.8x, all gold π=1", () => {
  // pseudo = y exactly → DSL coef [2, 3, −1.5]; naive on Ŷ = 2 + 3.8x − 1.5z exactly.
  const rand = mulberry32(13);
  const units = [];
  for (let i = 0; i < 50; i++) {
    const x = rand();
    const z = rand();
    const y = 2 + 3 * x - 1.5 * z;
    units.push({ yhat: y + 0.8 * x, y, pi: 1, x: [x, z] });
  }
  const r = dslOLS(units, 2);
  assert.deepEqual(r.coef.map((c) => c.name), ["(Intercept)", "x1", "x2"]);
  assert.ok(Math.abs(r.coef[0].est - 2) < EPS);
  assert.ok(Math.abs(r.coef[1].est - 3) < EPS);
  assert.ok(Math.abs(r.coef[2].est - (-1.5)) < EPS);
  assert.ok(Math.abs(r.naive[0].est - 2) < EPS);
  assert.ok(Math.abs(r.naive[1].est - 3.8) < EPS);
  assert.ok(Math.abs(r.naive[2].est - (-1.5)) < EPS);
  // noiseless: residuals 0 → se 0, p 0 for nonzero coefs (never NaN)
  for (const c of r.coef) {
    assert.ok(Number.isFinite(c.se) && c.se >= 0 && c.se < 1e-9);
    assert.ok(!Number.isNaN(c.p));
  }
});

test("dslOLS partial gold: corrects x-correlated machine bias (smoke, seeded)", () => {
  const rand = mulberry32(2026);
  const units = [];
  const n = 300;
  for (let i = 0; i < n; i++) {
    const x = rand();
    const z = rand();
    const y = 2 + 3 * x - 1.5 * z + (rand() - 0.5) * 0.4;
    const yhat = y + 0.6 * x + (rand() - 0.5) * 0.2; // bias rides on x
    units.push({ yhat, x: [x, z], _y: y });
  }
  // SRS of 100 without replacement (partial Fisher–Yates)
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let j = 0; j < 100; j++) {
    const k = j + Math.floor(rand() * (n - j));
    [idx[j], idx[k]] = [idx[k], idx[j]];
  }
  for (let j = 0; j < 100; j++) {
    const u = units[idx[j]];
    u.y = u._y;
    u.pi = 100 / n;
  }
  for (const u of units) delete u._y;
  const r = dslOLS(units, 2);
  assert.ok(Math.abs(r.coef[1].est - 3) < 0.5, `dsl slope ${r.coef[1].est}`);
  assert.ok(r.naive[1].est - r.coef[1].est > 0.25, "naive slope should sit ~0.6 above DSL");
  for (const c of [...r.coef, ...r.naive]) {
    assert.ok(Number.isFinite(c.se) && c.se > 0);
    assert.ok(Number.isFinite(c.z));
    assert.ok(c.p >= 0 && c.p <= 1);
  }
});

// ---------- dslLogit ----------

test("dslLogit all-gold π=1 equals models.logit on Y; naive equals logit on Ŷ", () => {
  const rand = mulberry32(31);
  const units = [];
  const X = [];
  const ys = [];
  const yhats = [];
  for (let i = 0; i < 300; i++) {
    const x = 2 * rand() - 1;
    const p = 1 / (1 + Math.exp(-(0.5 + 3 * x)));
    const y = rand() < p ? 1 : 0;
    const yhat = rand() < 0.2 ? 1 - y : y;
    units.push({ yhat, y, pi: 1, x: [x] });
    X.push([x]);
    ys.push(y);
    yhats.push(yhat);
  }
  const r = dslLogit(units, 1);
  const fitY = logit(ys, X);
  const fitYhat = logit(yhats, X);
  assert.deepEqual(r.coef.map((c) => c.name), ["(Intercept)", "x1"]);
  for (let j = 0; j < 2; j++) {
    assert.ok(Math.abs(r.coef[j].est - fitY.coef[j]) < 1e-6);
    assert.ok(Math.abs(r.naive[j].est - fitYhat.coef[j]) < 1e-9);
    assert.ok(Number.isFinite(r.coef[j].se) && r.coef[j].se > 0);
    assert.ok(r.coef[j].p >= 0 && r.coef[j].p <= 1);
  }
});

// ---------- validation edges ----------

test("edge: DSL requires gold units, valid pi, n ≥ 2", () => {
  assertThrowsCode(() => dslMean([{ yhat: 1 }, { yhat: 0 }]), "E_STAT_INSUFFICIENT");
  assertThrowsCode(() => dslMean([{ yhat: 1, y: 1, pi: 0.5 }]), "E_STAT_INSUFFICIENT");
  assertThrowsCode(() => dslMean([]), "E_STAT_INSUFFICIENT");
  // y without pi is a data bug, not silent non-gold
  assertThrowsCode(() => dslMean([{ yhat: 1, y: 1 }, { yhat: 0 }]), "E_STAT_INPUT");
  // pi without y likewise
  assertThrowsCode(() => dslMean([{ yhat: 1, pi: 0.5 }, { yhat: 0, y: 0, pi: 0.5 }]), "E_STAT_INPUT");
  assertThrowsCode(() => dslMean([{ yhat: 1, y: 1, pi: 0 }, { yhat: 0 }]), "E_STAT_INPUT");
  assertThrowsCode(() => dslMean([{ yhat: 1, y: 1, pi: 1.2 }, { yhat: 0 }]), "E_STAT_INPUT");
  assertThrowsCode(() => dslMean([{ yhat: NaN, y: 1, pi: 0.5 }, { yhat: 0 }]), "E_STAT_INPUT");
});

test("edge: dslOLS/dslLogit validate covariates and sample size", () => {
  const good = (k) => ({ yhat: 1, y: 1, pi: 1, x: Array.from({ length: k }, () => 0.5) });
  assertThrowsCode(() => dslOLS([good(2), { yhat: 0, x: [1] }], 2), "E_STAT_INPUT"); // ragged
  assertThrowsCode(() => dslOLS([good(2), { yhat: 0 }], 2), "E_STAT_INPUT"); // missing x
  assertThrowsCode(() => dslOLS([good(1), { yhat: 0, x: [1] }], 1), "E_STAT_INSUFFICIENT"); // n = 2 ≤ k+1 = 2
  assertThrowsCode(() => dslLogit([good(2), { yhat: 0, x: [1, 2] }], 3), "E_STAT_INPUT"); // k mismatch
});

test("edge: ppiMean needs ≥ 2 gold units", () => {
  assertThrowsCode(
    () => ppiMean([{ yhat: 1, y: 1, pi: 0.5 }, { yhat: 0 }, { yhat: 1 }]),
    "E_STAT_INSUFFICIENT"
  );
});
