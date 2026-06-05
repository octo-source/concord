// Bias correction — the Concord differentiator.
//
// DSL (design-based supervised learning): machine labels Ŷ on all n units,
// gold Y on a designed subsample (inclusion probability π stored per unit).
// Pseudo-outcome  Ỹ_i = Ŷ_i + (R_i/π_i)(Y_i − Ŷ_i)  replaces Y in the usual
// moment condition: mean → mean(Ỹ); OLS → regress Ỹ on X; logistic → solve
// Σ x_i(Ỹ_i − p_i(β)) = 0 by Newton (pseudo-outcomes may exit [0,1] —
// estimating equations tolerate that). Variance: sandwich A⁻¹BA⁻¹ / n with
// A the mean moment Jacobian and B the mean score outer product; CIs from
// normal quantiles. Unbiased regardless of machine-error structure because π
// is a design quantity; machine accuracy buys precision, not validity.
//
// `naive` = the same estimator computed on Ŷ alone with conventional
// (HC1 for regressions) standard errors — always reported beside the
// corrected number, never instead of it.
//
// units: [{yhat, y?, pi?, x?: number[]}] — gold rows have y AND pi.
import { ConcordError } from "../core/errors.js";
import { ols, logit } from "./models.js";
import { normQuantile, chi2Cdf } from "./distributions.js";

function bad(message, details = {}) {
  return new ConcordError("E_STAT_INPUT", message, details);
}

function insufficient(message, details = {}) {
  return new ConcordError("E_STAT_INSUFFICIENT", message, details);
}

const Z975 = normQuantile(0.975);

// Validate the units array; return parallel arrays. Gold = y AND pi present;
// y without pi (or pi without y) is a data bug, not a silent fallback.
function parseUnits(units, { k = null, binary = false } = {}) {
  if (!Array.isArray(units)) throw bad("units must be an array");
  const n = units.length;
  if (n < 2) throw insufficient("need at least 2 units", { n });
  const yhat = new Array(n);
  const pseudo = new Array(n);
  const X = k === null ? null : new Array(n);
  let nGold = 0;
  for (let i = 0; i < n; i++) {
    const u = units[i];
    if (!u || typeof u !== "object") throw bad("unit must be an object", { unit: i });
    if (typeof u.yhat !== "number" || !Number.isFinite(u.yhat)) {
      throw bad("unit.yhat must be a finite number", { unit: i });
    }
    if (binary && u.yhat !== 0 && u.yhat !== 1) {
      throw bad("proportion estimators require yhat of 0 or 1", { unit: i, yhat: u.yhat });
    }
    const hasY = u.y !== undefined && u.y !== null;
    const hasPi = u.pi !== undefined && u.pi !== null;
    if (hasY !== hasPi) {
      throw bad("gold units need BOTH y and pi; found one without the other", { unit: i });
    }
    yhat[i] = u.yhat;
    if (hasY) {
      if (typeof u.y !== "number" || !Number.isFinite(u.y)) {
        throw bad("unit.y must be a finite number", { unit: i });
      }
      if (binary && u.y !== 0 && u.y !== 1) {
        throw bad("proportion estimators require y of 0 or 1", { unit: i, y: u.y });
      }
      if (typeof u.pi !== "number" || !Number.isFinite(u.pi) || u.pi <= 0 || u.pi > 1) {
        throw bad("unit.pi must be in (0, 1]", { unit: i, pi: u.pi });
      }
      pseudo[i] = u.yhat + (u.y - u.yhat) / u.pi;
      nGold++;
    } else {
      pseudo[i] = u.yhat;
    }
    if (k !== null) {
      if (!Array.isArray(u.x) || u.x.length !== k) {
        throw bad(`unit.x must be a number[] of length k=${k}`, { unit: i });
      }
      for (const v of u.x) {
        if (typeof v !== "number" || !Number.isFinite(v)) {
          throw bad("unit.x must contain only finite numbers", { unit: i });
        }
      }
      X[i] = u.x;
    }
  }
  if (nGold === 0) {
    throw insufficient("DSL/PPI require gold units (y with inclusion probability pi)");
  }
  return { n, nGold, yhat, pseudo, X };
}

function mean(a) {
  let s = 0;
  for (const v of a) s += v;
  return s / a.length;
}

function sampleVar(a) {
  const m = mean(a);
  let s = 0;
  for (const v of a) s += (v - m) * (v - m);
  return s / (a.length - 1);
}

function ci(est, se) {
  return { ciLo: est - Z975 * se, ciHi: est + Z975 * se };
}

// Two-sided normal p-value from a finite z statistic, never NaN.
function pFromZ(z) {
  if (!Number.isFinite(z)) return 0;
  return 1 - chi2Cdf(z * z, 1);
}

// M2: se = 0 rows (typically a noiseless/saturated fit) get z: null, p: null
// plus an explanatory note instead of ±Infinity — JSON.stringify(±Infinity)
// is null anyway, which downstream readers would misparse as "no z computed
// for an ordinary row". Explicit nulls + note keep the payload JSON-safe and
// self-describing.
function coefRows(names, est, se) {
  return names.map((name, j) => {
    if (!(se[j] > 0)) {
      return {
        name,
        est: est[j],
        se: se[j],
        z: null,
        p: null,
        note: "standard error is 0 (no residual variation); z and p are undefined",
      };
    }
    const z = est[j] / se[j];
    return { name, est: est[j], se: se[j], z, p: pFromZ(z) };
  });
}

// ---------- means and proportions ----------

// DSL mean. Sandwich for the moment m(Ỹ; θ) = Ỹ − θ: A = 1,
// B = mean((Ỹ − θ̂)²) → Var = B/n.
export function dslMean(units) {
  const { n, pseudo, yhat } = parseUnits(units);
  const est = mean(pseudo);
  let B = 0;
  for (const v of pseudo) B += (v - est) * (v - est);
  B /= n;
  const se = Math.sqrt(B / n);
  const naiveEst = mean(yhat);
  const naiveSe = Math.sqrt(sampleVar(yhat) / n);
  return { est, se, ...ci(est, se), naive: { est: naiveEst, se: naiveSe } };
}

// DSL proportion: same estimator on 0/1 labels; the naive companion uses the
// conventional Wald SE sqrt(p̂(1−p̂)/n).
export function dslProportion(units) {
  const { n, pseudo, yhat } = parseUnits(units, { binary: true });
  const est = mean(pseudo);
  let B = 0;
  for (const v of pseudo) B += (v - est) * (v - est);
  B /= n;
  const se = Math.sqrt(B / n);
  const p = mean(yhat);
  return {
    est,
    se,
    ...ci(est, se),
    naive: { est: p, se: Math.sqrt((p * (1 - p)) / n) },
  };
}

// Difference of two independent DSL means (disjoint unit groups).
export function dslDiff(unitsA, unitsB) {
  const a = dslMean(unitsA);
  const b = dslMean(unitsB);
  const est = a.est - b.est;
  const se = Math.sqrt(a.se * a.se + b.se * b.se);
  const naiveSe = Math.sqrt(a.naive.se * a.naive.se + b.naive.se * b.naive.se);
  return {
    est,
    se,
    ...ci(est, se),
    naive: { est: a.naive.est - b.naive.est, se: naiveSe },
  };
}

// ---------- regressions ----------

const coefNames = (k) => ["(Intercept)", ...Array.from({ length: k }, (_, j) => `x${j + 1}`)];

// DSL OLS: regress Ỹ on X (intercept added internally). The DSL sandwich
// A⁻¹BA⁻¹/n is exactly HC0 on the pseudo-outcome regression, i.e. the HC1
// sandwich without its n/(n−p) inflation → rescale models.ols's seHC1.
export function dslOLS(units, k) {
  if (!Number.isInteger(k) || k < 0) throw bad("k must be a non-negative integer", { k });
  const { n, pseudo, yhat, X } = parseUnits(units, { k });
  const p = k + 1;
  if (n <= p) throw insufficient("need n > k + 1 for DSL OLS", { n, k });
  const fit = ols(pseudo, X);
  const hc0 = Math.sqrt((n - p) / n);
  const names = coefNames(k);
  const dslSe = fit.seHC1.map((s) => s * hc0);
  const naiveFit = ols(yhat, X);
  return {
    coef: coefRows(names, fit.coef, dslSe),
    naive: coefRows(names, naiveFit.coef, naiveFit.seHC1),
  };
}

// DSL logistic: solve Σ x_i(Ỹ_i − p_i(β)) = 0 by Newton with Hessian
// Σ p(1−p)xx' — exactly the IRLS iteration in models.logit, which accepts
// real-valued pseudo-outcomes for this purpose. Same HC0 rescaling as dslOLS.
export function dslLogit(units, k) {
  if (!Number.isInteger(k) || k < 0) throw bad("k must be a non-negative integer", { k });
  const { n, pseudo, yhat, X } = parseUnits(units, { k });
  const p = k + 1;
  if (n <= p) throw insufficient("need n > k + 1 for DSL logit", { n, k });
  const fit = logit(pseudo, X, { allowRealY: true });
  if (!fit.converged) {
    throw new ConcordError("E_STAT_DEGENERATE", "DSL logistic estimating equation did not converge", { n, k });
  }
  const naiveFit = logit(yhat, X, { allowRealY: true });
  if (!naiveFit.converged) {
    throw new ConcordError("E_STAT_DEGENERATE", "naive logistic regression did not converge", { n, k });
  }
  const hc0 = Math.sqrt((n - p) / n);
  const names = coefNames(k);
  return {
    coef: coefRows(names, fit.coef, fit.seHC1.map((s) => s * hc0)),
    naive: coefRows(names, naiveFit.coef, naiveFit.seHC1),
  };
}

// ---------- PPI ----------

function sampleCov(a, b) {
  const ma = mean(a);
  const mb = mean(b);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - ma) * (b[i] - mb);
  return s / (a.length - 1);
}

// PPI mean (rectifier form):
//   θ̂(λ) = λ·mean(Ŷ_all) + mean over gold of (Y − λŶ)  =  F̄ + R̄
// lambda: "classical" (= 1), a finite number, or "auto" (PPI++ power tuning).
//
// I2: classical PPI assumes the gold sample is equal-probability (SRS) — the
// unweighted gold mean of (Y − λŶ) is only unbiased for its population mean
// under equal π. Unequal gold π (stratified / uncertainty sampling) →
// E_STAT_INPUT directing the researcher to the DSL estimator, which uses π.
//
// R1/V1 — variance under Concord's OVERLAP design (gold ⊂ corpus). Writing
//   v_f = sampleVar(Ŷ) on ALL n units,  ĉ = sampleCov(Y, Ŷ) on gold,
// the textbook PPI/PPI++ variance λ²v_f/n + var(Y − λŶ on gold)/n_g treats
// F̄ and R̄ as independent, which is right only when the unlabeled and labeled
// samples are DISJOINT draws (as in the original papers). Concord never does
// that: every unit gets a machine label and gold is a subsample of those same
// units, so F̄ and R̄ share the n_g gold units and covary. Each gold unit i
// contributes Cov(λŶ_i/n, (Y_i − λŶ_i)/n_g) = λ(ĉ − λv_f)/(n·n_g); summing
// the n_g of them: Cov(F̄, R̄) = λ(ĉ − λv_f)/n. Hence
//   V(λ) = λ²v_f/n + var(Y − λŶ on gold)/n_g + 2λ(ĉ − λv_f)/n
//        = var(Y − λŶ on gold)/n_g + (2λĉ − λ²v_f)/n
// (population form: σ_Y²/n_g + (λ²σ_f² − 2λc)(1/n_g − 1/n)). The covariance
// term is O(1/n), so when n ≫ n_g the disjoint and overlap formulas converge;
// at high gold fractions (e.g. n_g/n = 1/2) the disjoint formula is badly
// miscalibrated. Adversarially verified by independent derivation plus a
// 40k-rep Monte Carlo: this V(λ) gives se²/empirical-var ≈ 1.00 across
// λ ∈ {0.25, 0.4, 0.65, 1.0} where the disjoint formula ranged 0.60–1.68.
//
// Auto-λ under overlap: minimizing the population form,
//   dV/dλ = 2(λσ_f² − c)(1/n_g − 1/n) = 0  →  λ̂ = ĉ/v_f,
// independent of the gold fraction — NOT the disjoint-sample PPI++ value
// ĉ/(v_f(1 + n_g/n)), whose (1 + n_g/n) shrinkage hedges a λ²v_f/n cost the
// overlap design does not pay in full. Degenerate v_f = 0 (constant Ŷ — no
// information) → λ̂ = 0, the gold-only estimator. λ̂ is a √n_g-consistent
// plug-in, so first-order inference may treat it as fixed (PPI++ Prop.
// 2-style argument); SE = sqrt(V(λ̂)). Honesty of the formula and the plug-in
// step is enforced by the seeded coverage simulations in
// tests/sim/dsl.sim.test.js, including the high-gold-fraction regime where
// the disjoint formula's coverage fell to ≈ 0.87.
export function ppiMean(units, { lambda } = { lambda: "classical" }) {
  let lam;
  let auto = false;
  if (lambda === undefined || lambda === "classical") lam = 1;
  else if (lambda === "auto") auto = true;
  else if (typeof lambda === "number" && Number.isFinite(lambda)) lam = lambda;
  else throw bad('ppiMean lambda must be "classical", "auto" or a finite number', { lambda });
  const { n, nGold, yhat } = parseUnits(units);
  if (nGold < 2) {
    throw insufficient("ppiMean needs at least 2 gold units for a variance", { nGold });
  }
  const goldY = [];
  const goldF = [];
  let piMin = Infinity;
  let piMax = -Infinity;
  for (const u of units) {
    if (u.y !== undefined && u.y !== null) {
      goldY.push(u.y);
      goldF.push(u.yhat);
      if (u.pi < piMin) piMin = u.pi;
      if (u.pi > piMax) piMax = u.pi;
    }
  }
  if (piMax - piMin > 1e-12) {
    throw bad(
      "PPI assumes an equal-probability (SRS) gold sample; " +
        "for stratified or uncertainty designs use the DSL estimator",
      { piMin, piMax }
    );
  }
  const vF = sampleVar(yhat);
  const cHat = sampleCov(goldY, goldF);
  if (auto) {
    lam = vF > 0 ? cHat / vF : 0;
  }
  const rect = goldY.map((y, i) => y - lam * goldF[i]);
  const est = lam * mean(yhat) + mean(rect);
  // Overlap-correct V(λ); see the derivation above. The plug-in can dip
  // below 0 in degenerate finite samples (e.g. constant gold rows beside
  // varying non-gold Ŷ), so truncate at 0 rather than emit a NaN se.
  const variance = sampleVar(rect) / nGold + (2 * lam * cHat - lam * lam * vF) / n;
  const se = Math.sqrt(Math.max(0, variance));
  const naiveEst = mean(yhat);
  const naiveSe = Math.sqrt(vF / n);
  return { est, se, lambda: lam, ...ci(est, se), naive: { est: naiveEst, se: naiveSe } };
}
