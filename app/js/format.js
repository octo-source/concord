// Number, CI, cost, and date formatting — journal convention throughout.
// Pure and DOM-free (probeable under node). Values rendered with these
// helpers should sit in .data / tabular-nums type.

/** Fixed-decimal number. fmt(0.8214) → "0.82". Handles null/NaN as "—". */
export function fmt(x, dp = 2) {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return Number(x).toFixed(dp);
}

/**
 * Journal style for statistics bounded in [−1, 1] (κ, α, r, p…):
 * the leading zero is dropped. fmtStat(0.82) → ".82", fmtStat(-0.5) → "−.50".
 * Values outside the bound fall back to fmt().
 */
export function fmtStat(x, dp = 2) {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  const n = Number(x);
  if (Math.abs(n) >= 1 || n === 0) return fmt(n, dp);
  const s = Math.abs(n).toFixed(dp).replace(/^0/, "");
  return (n < 0 ? "−" : "") + s;
}

/** p-value, journal style: p = .032, p < .001. */
export function fmtP(p) {
  if (p === null || p === undefined || Number.isNaN(p)) return "—";
  if (p < 0.001) return "p < .001";
  return `p = ${fmtStat(p, p < 0.01 ? 3 : 2)}`;
}

/** Confidence interval: fmtCI([0.214, 0.341]) → "[0.21, 0.34]". */
export function fmtCI(ci, dp = 2) {
  if (!ci) return "—";
  const lo = Array.isArray(ci) ? ci[0] : ci.lo;
  const hi = Array.isArray(ci) ? ci[1] : ci.hi;
  if (lo === undefined || hi === undefined) return "—";
  return `[${fmt(lo, dp)}, ${fmt(hi, dp)}]`;
}

/**
 * Cost in USD, mono chip convention: "$1.84". Sub-cent costs stay honest
 * ("$0.007") rather than rounding to zero; true zero is "$0.00".
 */
export function fmtCost(usd) {
  if (usd === null || usd === undefined || Number.isNaN(usd)) return "—";
  const n = Number(usd);
  if (n === 0) return "$0.00";
  if (Math.abs(n) < 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

/** Integer count with thousands separators: 12,847. */
export function fmtCount(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Math.round(Number(n)).toLocaleString("en-US");
}

/** Percentage from a proportion: fmtPct(0.342) → "34.2%". dp=0 → "34%". */
export function fmtPct(x, dp = 1) {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return `${(Number(x) * 100).toFixed(dp)}%`;
}

/** Compact token/unit counts: 950 → "950", 12400 → "12.4k", 2.1e6 → "2.1M". */
export function fmtCompact(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const x = Number(n);
  if (Math.abs(x) >= 1e6) return `${(x / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (Math.abs(x) >= 1e4) return `${(x / 1e3).toFixed(1).replace(/\.0$/, "")}k`;
  return fmtCount(x);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Jun 5, 2026" from ISO string / Date / epoch ms. */
export function fmtDate(d) {
  const t = toDate(d);
  if (!t) return "—";
  return `${MONTHS[t.getMonth()]} ${t.getDate()}, ${t.getFullYear()}`;
}

/** "Jun 5, 2026, 14:32" — runs and ledger moments. */
export function fmtDateTime(d) {
  const t = toDate(d);
  if (!t) return "—";
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  return `${fmtDate(t)}, ${hh}:${mm}`;
}

function toDate(d) {
  if (d === null || d === undefined) return null;
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? null : t;
}

/** Duration estimate in the level-up voice: fmtDuration(35) → "~35 min". */
export function fmtDuration(minutes) {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return "—";
  const m = Math.round(Number(minutes));
  if (m < 1) return "<1 min";
  if (m < 60) return `~${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `~${h} h` : `~${h} h ${rem} min`;
}

/** Elapsed clock for session timers: 95 → "1:35". */
export function fmtClock(totalSeconds) {
  if (totalSeconds === null || totalSeconds === undefined || Number.isNaN(totalSeconds)) return "—";
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = String(s % 60).padStart(2, "0");
  if (m < 60) return `${m}:${sec}`;
  const h = Math.floor(m / 60);
  return `${h}:${String(m % 60).padStart(2, "0")}:${sec}`;
}
