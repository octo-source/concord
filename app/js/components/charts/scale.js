// Pure scale arithmetic for the hand-rolled SVG charts. No DOM, no state —
// probeable under node (`node -e "import('./scale.js')…"`). All charts build
// their geometry from these.

/** [min, max] of finite values (ignores null/NaN). Empty → [0, 1]. */
export function extent(values) {
  let lo = Infinity, hi = -Infinity;
  for (const v of values) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    if (n < lo) lo = n;
    if (n > hi) hi = n;
  }
  if (lo === Infinity) return [0, 1];
  if (lo === hi) return lo === 0 ? [0, 1] : [Math.min(0, lo), Math.max(0, hi)];
  return [lo, hi];
}

/**
 * linearScale([d0,d1], [r0,r1]) → scale(x); scale.invert(px); scale.ticks(n).
 * Degenerate domains map to the range midpoint.
 */
export function linearScale(domain, range) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  const scale = (x) => (span === 0 ? (r0 + r1) / 2 : r0 + ((x - d0) / span) * (r1 - r0));
  scale.invert = (px) => (r1 - r0 === 0 ? d0 : d0 + ((px - r0) / (r1 - r0)) * span);
  scale.domain = [d0, d1];
  scale.range = [r0, r1];
  scale.ticks = (n = 4) => ticks(d0, d1, n);
  return scale;
}

/** Round a step to 1/2/5×10^k — the typographic tick alphabet. */
export function niceStep(rawStep) {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const frac = rawStep / pow;
  if (frac <= 1) return pow;
  if (frac <= 2) return 2 * pow;
  if (frac <= 5) return 5 * pow;
  return 10 * pow;
}

/** Nice tick values covering [lo, hi] with ~n ticks. */
export function ticks(lo, hi, n = 4) {
  if (lo === hi) return [lo];
  const step = niceStep((hi - lo) / Math.max(1, n));
  const start = Math.ceil(lo / step) * step;
  const out = [];
  // float-drift guard: count steps instead of accumulating
  for (let i = 0; ; i++) {
    const v = start + i * step;
    if (v > hi + step * 1e-9) break;
    out.push(roundTo(v, step));
    if (out.length > 50) break;
  }
  return out;
}

/** Expand [lo, hi] outward to tick-friendly bounds. */
export function niceDomain([lo, hi], n = 4) {
  if (lo === hi) return lo === 0 ? [0, 1] : [Math.min(0, lo), Math.max(0, hi)];
  const step = niceStep((hi - lo) / Math.max(1, n));
  return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step];
}

function roundTo(v, step) {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number(v.toFixed(Math.min(12, decimals + 1)));
}

/**
 * bandScale(count, [r0, r1], {paddingInner=0.25, paddingOuter=0.1})
 * → { at(i) → band start, bandwidth, step }
 */
export function bandScale(count, [r0, r1], { paddingInner = 0.25, paddingOuter = 0.1 } = {}) {
  const n = Math.max(0, count | 0);
  const span = r1 - r0;
  if (n === 0) return { at: () => r0, bandwidth: 0, step: 0 };
  const step = span / Math.max(1, n - paddingInner + 2 * paddingOuter);
  const bandwidth = step * (1 - paddingInner);
  const start = r0 + step * paddingOuter;
  return {
    at: (i) => start + step * i,
    bandwidth,
    step,
  };
}

/** Clamp helper. */
export function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}
