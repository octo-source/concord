// Monte-Carlo validation of the DSL estimators — the methodological release gate.
// Design (the DSL motivating case): machine errors correlate with X, so the naive
// plug-in is biased while DSL stays design-unbiased with honest analytic CIs.
//
//   n = 2000 units; X ~ Bernoulli(0.5); true Y ~ Bernoulli(0.3 + 0.3X)
//   machine Ŷ = Y flipped w.p. 0.25 when X=1, 0.05 when X=0
//   gold = SRS of 300 (π = 300/2000 for every gold unit)
//
// True difference in mean Y across X groups = 0.3.
// Naive expectation: E[Ŷ|X=1] − E[Ŷ|X=0] = 0.55 − 0.32 = 0.23 (bias −0.07).
// True logit slope (saturated binary-X model): logit(0.6) − logit(0.3).
import test from "node:test";
import assert from "node:assert/strict";
import { dslDiff, dslLogit } from "../../server/stats/correction.js";
import { mulberry32 } from "../../server/core/rng.js";

const N = 2000;
const N_GOLD = 300;
const REPS = 200;
const TRUE_DIFF = 0.3;
const TRUE_SLOPE = Math.log(0.6 / 0.4) - Math.log(0.3 / 0.7);

function generateRep(seed) {
  const rand = mulberry32(seed);
  const units = [];
  for (let i = 0; i < N; i++) {
    const x = rand() < 0.5 ? 1 : 0;
    const y = rand() < 0.3 + 0.3 * x ? 1 : 0;
    const flip = rand() < (x === 1 ? 0.25 : 0.05);
    const yhat = flip ? 1 - y : y;
    units.push({ yhat, x: [x], _trueY: y });
  }
  // SRS of N_GOLD without replacement via partial Fisher–Yates
  const idx = Array.from({ length: N }, (_, i) => i);
  for (let j = 0; j < N_GOLD; j++) {
    const k = j + Math.floor(rand() * (N - j));
    [idx[j], idx[k]] = [idx[k], idx[j]];
  }
  for (let j = 0; j < N_GOLD; j++) {
    const u = units[idx[j]];
    u.y = u._trueY;
    u.pi = N_GOLD / N;
  }
  return units;
}

test("DSL sim: dslDiff unbiased with honest coverage while naive diff is biased", { timeout: 120000 }, () => {
  let sumDsl = 0;
  let sumNaive = 0;
  let covered = 0;
  let sumSlope = 0;
  let sumNaiveSlope = 0;
  let slopeCovered = 0;
  const t0 = process.hrtime.bigint();

  for (let rep = 0; rep < REPS; rep++) {
    const units = generateRep(910_001 + rep * 7);

    // difference in mean Y between X=1 and X=0 groups
    const groupA = [];
    const groupB = [];
    for (const u of units) {
      const row = { yhat: u.yhat };
      if (u.pi !== undefined) {
        row.y = u.y;
        row.pi = u.pi;
      }
      (u.x[0] === 1 ? groupA : groupB).push(row);
    }
    const d = dslDiff(groupA, groupB);
    sumDsl += d.est;
    sumNaive += d.naive.est;
    if (d.ciLo <= TRUE_DIFF && TRUE_DIFF <= d.ciHi) covered++;

    // logistic slope on the same data
    const lg = dslLogit(
      units.map((u) =>
        u.pi !== undefined
          ? { yhat: u.yhat, y: u.y, pi: u.pi, x: u.x }
          : { yhat: u.yhat, x: u.x }
      ),
      1
    );
    const slope = lg.coef[1];
    sumSlope += slope.est;
    sumNaiveSlope += lg.naive[1].est;
    const lo = slope.est - 1.959963984540054 * slope.se;
    const hi = slope.est + 1.959963984540054 * slope.se;
    if (lo <= TRUE_SLOPE && TRUE_SLOPE <= hi) slopeCovered++;
  }

  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const meanDsl = sumDsl / REPS;
  const meanNaive = sumNaive / REPS;
  const coverage = covered / REPS;
  const meanSlope = sumSlope / REPS;
  const meanNaiveSlope = sumNaiveSlope / REPS;
  const slopeCoverage = slopeCovered / REPS;
  const dslSlopeBias = Math.abs(meanSlope - TRUE_SLOPE);
  const naiveSlopeBias = Math.abs(meanNaiveSlope - TRUE_SLOPE);

  console.log(
    `[dsl.sim] ${REPS} reps in ${elapsedMs.toFixed(0)}ms | ` +
      `diff: dsl=${meanDsl.toFixed(4)} naive=${meanNaive.toFixed(4)} cover=${coverage.toFixed(3)} | ` +
      `slope: dsl=${meanSlope.toFixed(4)} naive=${meanNaiveSlope.toFixed(4)} ` +
      `(true ${TRUE_SLOPE.toFixed(4)}) cover=${slopeCoverage.toFixed(3)}`
  );

  // dslDiff: unbiased within MC error; naive visibly biased; honest coverage
  assert.ok(Math.abs(meanDsl - TRUE_DIFF) < 0.015, `DSL diff bias ${meanDsl - TRUE_DIFF}`);
  assert.ok(Math.abs(meanNaive - TRUE_DIFF) > 0.05, `naive diff bias ${meanNaive - TRUE_DIFF}`);
  assert.ok(coverage >= 0.91 && coverage <= 0.985, `DSL diff coverage ${coverage}`);

  // dslLogit slope: bias ≪ naive bias; honest coverage
  assert.ok(
    dslSlopeBias < naiveSlopeBias / 3,
    `DSL slope bias ${dslSlopeBias} vs naive ${naiveSlopeBias}`
  );
  assert.ok(
    slopeCoverage >= 0.91 && slopeCoverage <= 0.985,
    `DSL slope coverage ${slopeCoverage}`
  );
});
