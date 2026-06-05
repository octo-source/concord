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

// Two-sided normal p-value from a z statistic, never NaN. se = 0 cases are
// resolved by the caller passing z = ±Infinity (p → 0) or z = 0 (p → 1).
function pFromZ(z) {
  if (!Number.isFinite(z)) return 0;
  return 1 - chi2Cdf(z * z, 1);
}

function coefRows(names, est, se) {
  return names.map((name, j) => {
    let z;
    if (se[j] > 0) z = est[j] / se[j];
    else z = est[j] === 0 ? 0 : Math.sign(est[j]) * Infinity;
    const p = z === 0 ? 1 : pFromZ(z);
    return { name, est: est[j], se: se[j], z, p };
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

// PPI classical (λ = 1 rectifier form):
//   θ̂ = λ·mean(Ŷ_all) + mean over gold of (Y − λŶ)
//   SE = sqrt(λ²·var(Ŷ_all)/n + var(Y − λŶ on gold)/n_gold)
// lambda: "classical" (= 1) or a finite number. PPI++ power tuning ("auto")
// is not implemented in v1 and is rejected explicitly.
export function ppiMean(units, { lambda } = { lambda: "classical" }) {
  let lam;
  if (lambda === undefined || lambda === "classical") lam = 1;
  else if (typeof lambda === "number" && Number.isFinite(lambda)) lam = lambda;
  else throw bad('ppiMean lambda must be "classical" or a finite number (PPI++ "auto" is not in v1)', { lambda });
  const { n, nGold, yhat } = parseUnits(units);
  if (nGold < 2) {
    throw insufficient("ppiMean needs at least 2 gold units for a variance", { nGold });
  }
  const rect = [];
  for (const u of units) {
    if (u.y !== undefined && u.y !== null) rect.push(u.y - lam * u.yhat);
  }
  const est = lam * mean(yhat) + mean(rect);
  const se = Math.sqrt((lam * lam * sampleVar(yhat)) / n + sampleVar(rect) / nGold);
  const naiveEst = mean(yhat);
  const naiveSe = Math.sqrt(sampleVar(yhat) / n);
  return { est, se, ...ci(est, se), naive: { est: naiveEst, se: naiveSe } };
}
