// Regression models: OLS and logistic (IRLS). X is given WITHOUT an intercept
// column; an intercept is prepended internally. Robust HC1 sandwich standard
// errors. Pure deterministic functions — no randomness anywhere.
//
// Note on logit: y is permitted to be any finite real (not just 0/1) because
// correction.js solves DSL estimating equations with pseudo-outcomes that may
// exit [0, 1]. The quasi-score Σ x_i (y_i − p_i(β)) = 0 with Newton steps on
// the Hessian Σ p(1−p) x x' is exactly the same iteration, so one solver
// serves both. The PUBLIC contract for ordinary logistic regression is 0/1 —
// enforced unless opts.allowRealY (used internally by correction.js).
import { ConcordError } from "../core/errors.js";

function bad(message, details = {}) {
  return new ConcordError("E_STAT_INPUT", message, details);
}

// ---------- small dense linear algebra (k is tiny; clarity over speed) ----------

// Solve A·x = rhs for square A via Gaussian elimination with partial pivoting.
// Throws E_STAT_DEGENERATE on (numerically) singular A.
//
// Singularity test (I3): the pivot is compared against a RELATIVE tolerance,
// 1e-10 × the largest |entry| currently in the pivot column (all rows — the
// already-pivoted rows above still carry the column's original scale under
// Gauss–Jordan). An absolute tolerance (the old 1e-12) wrongly declared
// well-conditioned but tiny-scaled covariates (~1e-8) singular; a relative
// one is invariant under column rescaling. Truly collinear columns reduce to
// rounding residue ~1e-16 × scale < tol → still throw. The tiny absolute
// floor only catches the exactly-all-zero column (colMax = 0).
function solveLinear(A, rhs) {
  const n = A.length;
  // augmented working copy
  const M = A.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    let colMax = Math.abs(M[0][col]);
    for (let r = 1; r < n; r++) {
      const v = Math.abs(M[r][col]);
      if (v > colMax) colMax = v;
      if (r > col && v > Math.abs(M[pivot][col])) pivot = r;
    }
    const tol = Math.max(1e-10 * colMax, 1e-280);
    if (Math.abs(M[pivot][col]) < tol) {
      throw new ConcordError(
        "E_STAT_DEGENERATE",
        "design matrix is singular (collinear or constant covariates)",
        { column: col }
      );
    }
    if (pivot !== col) {
      const tmp = M[col];
      M[col] = M[pivot];
      M[pivot] = tmp;
    }
    const inv = 1 / M[col][col];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] * inv;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / M[i][i]);
}

// Inverse of a square matrix by solving against the identity.
function matInverse(A) {
  const n = A.length;
  const cols = [];
  for (let j = 0; j < n; j++) {
    const e = new Array(n).fill(0);
    e[j] = 1;
    cols.push(solveLinear(A, e));
  }
  // cols[j] is the j-th column of A⁻¹ → transpose into rows
  const inv = [];
  for (let i = 0; i < n; i++) inv.push(cols.map((c) => c[i]));
  return inv;
}

// C = A·B for dense rectangular matrices.
function matMul(A, B) {
  const n = A.length;
  const m = B[0].length;
  const inner = B.length;
  const C = [];
  for (let i = 0; i < n; i++) {
    const row = new Array(m).fill(0);
    for (let t = 0; t < inner; t++) {
      const a = A[i][t];
      if (a === 0) continue;
      const Bt = B[t];
      for (let j = 0; j < m; j++) row[j] += a * Bt[j];
    }
    C.push(row);
  }
  return C;
}

// Validate y + X, return the design matrix with intercept prepended.
function buildDesign(y, X) {
  if (!Array.isArray(y) || !Array.isArray(X)) {
    throw bad("ols/logit require y: number[] and X: number[][]");
  }
  if (y.length !== X.length) {
    throw bad("y and X must have the same length", { ny: y.length, nx: X.length });
  }
  const n = y.length;
  if (n === 0) {
    throw new ConcordError("E_STAT_INSUFFICIENT", "no observations");
  }
  const k = Array.isArray(X[0]) ? X[0].length : -1;
  if (k < 0) throw bad("X must be an array of rows (number[][])");
  const design = new Array(n);
  for (let i = 0; i < n; i++) {
    const row = X[i];
    if (!Array.isArray(row) || row.length !== k) {
      throw bad("X rows must all have the same length", { row: i });
    }
    if (typeof y[i] !== "number" || !Number.isFinite(y[i])) {
      throw bad("y must contain only finite numbers", { row: i });
    }
    const d = new Array(k + 1);
    d[0] = 1;
    for (let j = 0; j < k; j++) {
      const v = row[j];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw bad("X must contain only finite numbers", { row: i, col: j });
      }
      d[j + 1] = v;
    }
    design[i] = d;
  }
  const p = k + 1;
  if (n <= p) {
    throw new ConcordError("E_STAT_INSUFFICIENT", "need n > #parameters", { n, p });
  }
  return { design, n, p };
}

// X'·diag(w)·X (w omitted → ones) and X'·diag(w)·v helpers.
function xtwx(design, w) {
  const n = design.length;
  const p = design[0].length;
  const M = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; i < n; i++) {
    const row = design[i];
    const wi = w ? w[i] : 1;
    for (let a = 0; a < p; a++) {
      const f = wi * row[a];
      if (f === 0) continue;
      for (let b = a; b < p; b++) M[a][b] += f * row[b];
    }
  }
  for (let a = 0; a < p; a++) for (let b = 0; b < a; b++) M[a][b] = M[b][a];
  return M;
}

function xtv(design, v) {
  const n = design.length;
  const p = design[0].length;
  const out = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const row = design[i];
    const vi = v[i];
    if (vi === 0) continue;
    for (let a = 0; a < p; a++) out[a] += row[a] * vi;
  }
  return out;
}

// Sandwich (X'X)⁻¹ or A⁻¹ · meat · A⁻¹ diagonal → SEs, with optional scale factor.
function sandwichSE(Ainv, meat, factor) {
  const V = matMul(matMul(Ainv, meat), Ainv);
  const p = V.length;
  const se = new Array(p);
  for (let j = 0; j < p; j++) {
    const v = V[j][j] * factor;
    se[j] = v > 0 ? Math.sqrt(v) : 0;
  }
  return se;
}

// ---------- OLS ----------
// ols(y, X) → {coef, seHC1, r2}. HC1: (X'X)⁻¹ (Σ xᵢxᵢ'eᵢ²) (X'X)⁻¹ · n/(n−p).
export function ols(y, X) {
  const { design, n, p } = buildDesign(y, X);
  const XtX = xtwx(design);
  const Xty = xtv(design, y);
  const coef = solveLinear(XtX, Xty);
  // residuals
  const resid = new Array(n);
  let sse = 0;
  let sst = 0;
  const ybar = y.reduce((a, b) => a + b, 0) / n;
  for (let i = 0; i < n; i++) {
    let fit = 0;
    const row = design[i];
    for (let j = 0; j < p; j++) fit += row[j] * coef[j];
    const e = y[i] - fit;
    resid[i] = e;
    sse += e * e;
    sst += (y[i] - ybar) * (y[i] - ybar);
  }
  const XtXinv = matInverse(XtX);
  const meat = xtwx(design, resid.map((e) => e * e));
  const seHC1 = sandwichSE(XtXinv, meat, n / (n - p));
  // M6: R² = 1 − SSE/SST is undefined when y is constant (SST = 0). Returning
  // 1 overstated fit; null says "not a meaningful quantity here".
  const r2 = sst > 0 ? 1 - sse / sst : null;
  return { coef, seHC1, r2 };
}

// ---------- logistic regression (IRLS / Newton on the score) ----------
// logit(y, X, opts?) → {coef, seHC1, converged}. Max 50 iterations.
// Sandwich: A⁻¹ B A⁻¹ with A = Σ p(1−p)xx', B = Σ xx'(y−p)², HC1 factor n/(n−p).
export function logit(y, X, opts = {}) {
  const { design, n, p } = buildDesign(y, X);
  if (!opts.allowRealY) {
    for (let i = 0; i < n; i++) {
      if (y[i] !== 0 && y[i] !== 1) {
        throw bad("logit requires y values of 0 or 1", { row: i, value: y[i] });
      }
    }
  }
  let beta = new Array(p).fill(0);
  let converged = false;
  const probs = new Array(n);
  const weights = new Array(n);
  const scoreResid = new Array(n);
  for (let iter = 0; iter < 50; iter++) {
    for (let i = 0; i < n; i++) {
      let eta = 0;
      const row = design[i];
      for (let j = 0; j < p; j++) eta += row[j] * beta[j];
      if (eta > 30) eta = 30;
      else if (eta < -30) eta = -30;
      const pi = 1 / (1 + Math.exp(-eta));
      probs[i] = pi;
      const w = pi * (1 - pi);
      weights[i] = w < 1e-10 ? 1e-10 : w;
      scoreResid[i] = y[i] - pi;
    }
    const H = xtwx(design, weights);
    const g = xtv(design, scoreResid);
    let step;
    try {
      step = solveLinear(H, g);
    } catch (err) {
      if (err instanceof ConcordError && err.code === "E_STAT_DEGENERATE") {
        // Hessian collapsed (separation) — stop, report non-convergence.
        break;
      }
      throw err;
    }
    let maxStep = 0;
    for (let j = 0; j < p; j++) {
      beta[j] += step[j];
      const a = Math.abs(step[j]);
      if (a > maxStep) maxStep = a;
    }
    if (maxStep < 1e-10) {
      converged = true;
      break;
    }
  }
  // final probabilities at the returned beta
  for (let i = 0; i < n; i++) {
    let eta = 0;
    const row = design[i];
    for (let j = 0; j < p; j++) eta += row[j] * beta[j];
    if (eta > 30) eta = 30;
    else if (eta < -30) eta = -30;
    const pi = 1 / (1 + Math.exp(-eta));
    probs[i] = pi;
    const w = pi * (1 - pi);
    weights[i] = w < 1e-10 ? 1e-10 : w;
    scoreResid[i] = y[i] - pi;
  }
  const A = xtwx(design, weights);
  const B = xtwx(design, scoreResid.map((e) => e * e));
  let seHC1;
  try {
    seHC1 = sandwichSE(matInverse(A), B, n / (n - p));
  } catch (err) {
    if (err instanceof ConcordError && err.code === "E_STAT_DEGENERATE") {
      seHC1 = new Array(p).fill(0);
      converged = false;
    } else {
      throw err;
    }
  }
  return { coef: beta, seHC1, converged };
}
