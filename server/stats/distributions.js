// Statistical distribution functions — pure, deterministic, dependency-free.
// normQuantile: Acklam's rational approximation + one Halley refinement.
// chi2Cdf: regularized lower incomplete gamma P(df/2, x/2) (series + Lentz CF).
// tCdf: regularized incomplete beta. bhQValues: Benjamini–Hochberg step-up.
import { ConcordError } from "../core/errors.js";

function bad(message, details = {}) {
  return new ConcordError("E_STAT_INPUT", message, details);
}

// ---------- log-gamma (Lanczos, g=7, n=9) ----------
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

function lgamma(z) {
  if (z < 0.5) {
    // reflection: Γ(z)Γ(1−z) = π / sin(πz)
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  }
  z -= 1;
  let a = LANCZOS[0];
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

// ---------- regularized lower incomplete gamma P(a, x) ----------
function gammaPSeries(a, x) {
  let sum = 1 / a;
  let term = sum;
  let n = a;
  for (let i = 0; i < 500; i++) {
    n += 1;
    term *= x / n;
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
}

function gammaQContinuedFraction(a, x) {
  // Lentz's algorithm for Q(a,x); P = 1 − Q
  const FPMIN = 1e-300;
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return h * Math.exp(-x + a * Math.log(x) - lgamma(a));
}

function gammaP(a, x) {
  if (x === 0) return 0;
  if (x < a + 1) return gammaPSeries(a, x);
  return 1 - gammaQContinuedFraction(a, x);
}

// ---------- regularized incomplete beta I_x(a, b) ----------
function betacf(a, b, x) {
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 500; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return h;
}

function ibeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lgamma(a + b) - lgamma(a) - lgamma(b);
  const front = Math.exp(lbeta + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (front * betacf(a, b, x)) / a;
  return 1 - (front * betacf(b, a, 1 - x)) / b;
}

// Internal standard-normal CDF via the incomplete gamma (high accuracy).
function normCdf(x) {
  if (x === 0) return 0.5;
  const p = 0.5 * gammaP(0.5, (x * x) / 2);
  return x > 0 ? 0.5 + p : 0.5 - p;
}

// ---------- exports ----------

// Inverse standard-normal CDF. Acklam's approximation (rel. err < 1.2e-9)
// followed by one Halley step against the incomplete-gamma CDF → ~1e-15.
export function normQuantile(p) {
  if (typeof p !== "number" || !Number.isFinite(p) || p <= 0 || p >= 1) {
    throw bad("normQuantile requires p in the open interval (0, 1)", { p });
  }
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ];
  const pLow = 0.02425;
  let x;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pLow) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  // Halley refinement — skipped in the far tails where exp(x²/2) would
  // overflow (|x| ≳ 37.6); Acklam alone is already ~1e-9 relative there.
  const e = normCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  const denom = 1 + (x * u) / 2;
  if (Number.isFinite(u) && denom !== 0) {
    const refined = x - u / denom;
    if (Number.isFinite(refined)) x = refined;
  }
  return x;
}

// CDF of the chi-square distribution with df degrees of freedom.
export function chi2Cdf(x, df) {
  if (typeof x !== "number" || !Number.isFinite(x) || x < 0) {
    throw bad("chi2Cdf requires x ≥ 0", { x });
  }
  if (typeof df !== "number" || !Number.isFinite(df) || df <= 0) {
    throw bad("chi2Cdf requires df > 0", { df });
  }
  return gammaP(df / 2, x / 2);
}

// CDF of Student's t distribution with df degrees of freedom.
export function tCdf(x, df) {
  if (typeof x !== "number" || !Number.isFinite(x)) {
    throw bad("tCdf requires finite x", { x });
  }
  if (typeof df !== "number" || !Number.isFinite(df) || df <= 0) {
    throw bad("tCdf requires df > 0", { df });
  }
  if (x === 0) return 0.5;
  const half = 0.5 * ibeta(df / 2, 0.5, df / (df + x * x));
  return x > 0 ? 1 - half : half;
}

// Benjamini–Hochberg q-values: step-up monotone minimum, original order, capped at 1.
export function bhQValues(ps) {
  if (!Array.isArray(ps)) throw bad("bhQValues requires an array of p-values");
  const m = ps.length;
  for (const p of ps) {
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
      throw bad("bhQValues: every p must be a number in [0, 1]", { p });
    }
  }
  if (m === 0) return [];
  const order = ps.map((p, i) => [p, i]).sort((u, v) => u[0] - v[0]);
  const q = new Array(m);
  let running = 1;
  for (let r = m - 1; r >= 0; r--) {
    const [p, origIdx] = order[r];
    running = Math.min(running, (p * m) / (r + 1));
    q[origIdx] = running;
  }
  return q;
}
