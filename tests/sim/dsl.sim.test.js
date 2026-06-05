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
import { dslDiff, dslLogit, dslOLS, ppiMean } from "../../server/stats/correction.js";
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
  let olsCovered = 0; // M7
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

    const dslRows = units.map((u) =>
      u.pi !== undefined
        ? { yhat: u.yhat, y: u.y, pi: u.pi, x: u.x }
        : { yhat: u.yhat, x: u.x }
    );

    // logistic slope on the same data
    const lg = dslLogit(dslRows, 1);
    const slope = lg.coef[1];
    sumSlope += slope.est;
    sumNaiveSlope += lg.naive[1].est;
    const lo = slope.est - 1.959963984540054 * slope.se;
    const hi = slope.est + 1.959963984540054 * slope.se;
    if (lo <= TRUE_SLOPE && TRUE_SLOPE <= hi) slopeCovered++;

    // M7: dslOLS on the same data — with binary X the linear-probability slope
    // is E[Y|X=1] − E[Y|X=0] = TRUE_DIFF, so its CI coverage is checkable here.
    const olsSlope = dslOLS(dslRows, 1).coef[1];
    const olo = olsSlope.est - 1.959963984540054 * olsSlope.se;
    const ohi = olsSlope.est + 1.959963984540054 * olsSlope.se;
    if (olo <= TRUE_DIFF && TRUE_DIFF <= ohi) olsCovered++;
  }

  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const meanDsl = sumDsl / REPS;
  const meanNaive = sumNaive / REPS;
  const coverage = covered / REPS;
  const meanSlope = sumSlope / REPS;
  const meanNaiveSlope = sumNaiveSlope / REPS;
  const slopeCoverage = slopeCovered / REPS;
  const olsCoverage = olsCovered / REPS;
  const dslSlopeBias = Math.abs(meanSlope - TRUE_SLOPE);
  const naiveSlopeBias = Math.abs(meanNaiveSlope - TRUE_SLOPE);

  console.log(
    `[dsl.sim] ${REPS} reps in ${elapsedMs.toFixed(0)}ms | ` +
      `diff: dsl=${meanDsl.toFixed(4)} naive=${meanNaive.toFixed(4)} cover=${coverage.toFixed(3)} | ` +
      `slope: dsl=${meanSlope.toFixed(4)} naive=${meanNaiveSlope.toFixed(4)} ` +
      `(true ${TRUE_SLOPE.toFixed(4)}) cover=${slopeCoverage.toFixed(3)} | ` +
      `olsSlope cover=${olsCoverage.toFixed(3)}`
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

  // M7: dslOLS slope CI coverage on the same designs
  assert.ok(
    olsCoverage >= 0.91 && olsCoverage <= 0.985,
    `dslOLS slope coverage ${olsCoverage}`
  );
});

// ---------- R1: PPI++ auto-λ power tuning ----------
//
// Design: continuous outcome Y = 1 + ε, ε ~ N(0,1); machine proxy
// Ŷ = 0.5·Y + N(0,1). n = 1000, gold = SRS of 100 (π = 0.1 for all gold).
// Population quantities: v_Y = 1, c = Cov(Y,Ŷ) = 0.5, v_f = 0.25 + 1 = 1.25.
// Overlap-correct theory (gold ⊂ corpus, see correction.js):
//   V(λ) = (v_Y − 2λc + λ²v_f)/n_g + (2λc − λ²v_f)/n, minimized at
//   λ* = c/v_f = 0.4, and
//   Var(λ=0, gold-only)  = 1/100                       = 0.01000
//   Var(λ=1, classical)  = 1.25/100 + (1 − 1.25)/1000  = 0.01225
//   Var(λ*)              = (1 − 0.2)/100 + 0.2/1000    = 0.00820
// so auto-λ must beat BOTH baselines — the defining property of power tuning.
// MC slack: each empirical variance over 200 reps has relative sd
// ≈ √(2/199) ≈ 10%, so a ratio test carries ≈ 14% noise; the true ratios are
// ≤ 0.82, leaving a wide margin under a 1.10 multiplicative slack.
test("R1 sim: auto-λ variance ≤ classical and ≤ gold-only (+MC slack); honest coverage", { timeout: 120000 }, () => {
  const N = 1000;
  const NG = 100;
  const TRUTH = 1;
  const ests = { auto: [], classical: [], gold: [] };
  let covered = 0;
  let sumLambda = 0;

  for (let rep = 0; rep < REPS; rep++) {
    const rand = mulberry32(550_007 + rep * 11);
    // Box–Muller standard normals from the seeded uniform stream
    const normal = () => {
      const u1 = 1 - rand(); // (0, 1] — avoids log(0)
      const u2 = rand();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };
    const units = [];
    for (let i = 0; i < N; i++) {
      const y = TRUTH + normal();
      const yhat = 0.5 * y + normal();
      units.push({ yhat, _y: y });
    }
    // SRS of NG without replacement (partial Fisher–Yates), equal π
    const idx = Array.from({ length: N }, (_, i) => i);
    for (let j = 0; j < NG; j++) {
      const k = j + Math.floor(rand() * (N - j));
      [idx[j], idx[k]] = [idx[k], idx[j]];
    }
    for (let j = 0; j < NG; j++) {
      const u = units[idx[j]];
      u.y = u._y;
      u.pi = NG / N;
    }
    for (const u of units) delete u._y;

    const auto = ppiMean(units, { lambda: "auto" });
    ests.auto.push(auto.est);
    ests.classical.push(ppiMean(units, { lambda: "classical" }).est);
    ests.gold.push(ppiMean(units, { lambda: 0 }).est);
    sumLambda += auto.lambda;
    if (auto.ciLo <= TRUTH && TRUTH <= auto.ciHi) covered++;
  }

  const empVar = (a) => {
    const m = a.reduce((x, y) => x + y, 0) / a.length;
    return a.reduce((x, y) => x + (y - m) * (y - m), 0) / (a.length - 1);
  };
  const vAuto = empVar(ests.auto);
  const vClassical = empVar(ests.classical);
  const vGold = empVar(ests.gold);
  const coverage = covered / REPS;
  const meanLambda = sumLambda / REPS;

  console.log(
    `[ppi.sim] ${REPS} reps | var auto=${vAuto.toExponential(3)} ` +
      `classical=${vClassical.toExponential(3)} gold=${vGold.toExponential(3)} | ` +
      `mean λ̂=${meanLambda.toFixed(3)} cover=${coverage.toFixed(3)}`
  );

  // (c) power tuning: auto beats both baselines up to MC slack
  assert.ok(vAuto <= vClassical * 1.1, `auto var ${vAuto} vs classical ${vClassical}`);
  assert.ok(vAuto <= vGold * 1.1, `auto var ${vAuto} vs gold-only ${vGold}`);
  // λ̂ actually tunes (≈0.4 here), i.e. it is neither pinned at 0 nor at 1
  assert.ok(meanLambda > 0.2 && meanLambda < 0.55, `mean λ̂ ${meanLambda}`);
  // (d) honest CIs at the plug-in λ̂
  assert.ok(coverage >= 0.91 && coverage <= 0.985, `auto-λ coverage ${coverage}`);
});

// ---------- V1: overlap variance in the high-gold-fraction regime ----------
//
// Gold ⊂ corpus with n_g/n = 1/2 is exactly where the disjoint-sample PPI
// variance breaks: the Cov(F̄, R̄) term it omits is O(1/n), negligible when
// n ≫ n_g but first-order here. Design: n = 600, gold = SRS of 300,
// Y = 1 + N(0,1), strong proxy Ŷ = Y + N(0, 0.2²) so v_Y = 1, c = 1,
// v_f = 1.04. Overlap theory: λ* = c/v_f = 1/1.04 ≈ 0.962,
//   Var(λ*) = (v_Y − c²/v_f)/n_g + (c²/v_f)/n ≈ 0.0385/300 + 0.9615/600
//           ≈ 1.73e-3.
// The disjoint formula in this regime under-reports the auto-λ variance by
// ≈ 40% (its λ̂ ≈ 0.64 sits far from the overlap optimum AND the missing
// covariance term is large) → ≈ 0.87 empirical coverage. The overlap formula
// must restore nominal coverage.
test("V1 sim (high gold fraction): auto-λ coverage stays honest at n_g/n = 1/2", { timeout: 120000 }, () => {
  const N2 = 600;
  const NG2 = 300;
  const TRUTH = 1;
  let covered = 0;
  let sumLambda = 0;

  for (let rep = 0; rep < REPS; rep++) {
    const rand = mulberry32(770_013 + rep * 13);
    const normal = () => {
      const u1 = 1 - rand(); // (0, 1] — avoids log(0)
      const u2 = rand();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };
    const units = [];
    for (let i = 0; i < N2; i++) {
      const y = TRUTH + normal();
      const yhat = y + 0.2 * normal();
      units.push({ yhat, _y: y });
    }
    // SRS of NG2 without replacement (partial Fisher–Yates), equal π
    const idx = Array.from({ length: N2 }, (_, i) => i);
    for (let j = 0; j < NG2; j++) {
      const k = j + Math.floor(rand() * (N2 - j));
      [idx[j], idx[k]] = [idx[k], idx[j]];
    }
    for (let j = 0; j < NG2; j++) {
      const u = units[idx[j]];
      u.y = u._y;
      u.pi = NG2 / N2;
    }
    for (const u of units) delete u._y;

    const r = ppiMean(units, { lambda: "auto" });
    sumLambda += r.lambda;
    if (r.ciLo <= TRUTH && TRUTH <= r.ciHi) covered++;
  }

  const coverage = covered / REPS;
  const meanLambda = sumLambda / REPS;
  console.log(
    `[ppi.sim.highgold] ${REPS} reps | mean λ̂=${meanLambda.toFixed(3)} cover=${coverage.toFixed(3)}`
  );

  // λ̂ tracks the overlap optimum c/v_f ≈ 0.962, not the disjoint ≈ 0.64
  assert.ok(meanLambda > 0.85 && meanLambda < 1.05, `mean λ̂ ${meanLambda}`);
  // the regime the disjoint formula failed (≈ 0.87): nominal coverage required
  assert.ok(coverage >= 0.92 && coverage <= 0.98, `high-gold auto-λ coverage ${coverage}`);
});
