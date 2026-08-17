// Panel aggregation: combine several jurors' outputs on ONE unit into a
// single verdict. Pure functions — no I/O, no randomness, no clocks.
//
// Input contract: `outputsByJuror` is either
//   - an array of outputs each carrying {juror, label, confidence?}, or
//   - a plain object Record<juror, {label, confidence?}>.
// Both normalize to the same ordered list (array order, or the object's key
// order). Duplicate juror ids are a caller bug → ConcordError("VALIDATION").
//
// Aggregation rules (panelPayload.aggregation):
//   majority             modal label; ties → {flagged: true}, no label.
//   mean / median        numeric labels ONLY (numbers or numeric strings) —
//                        anything else throws VALIDATION. Median of an even
//                        count is the average of the middle two.
//   unanimityOrFlag      all jurors identical → that label, else flagged.
//   confidenceWeighted   votes weighted by each juror's confidence (absent or
//                        null confidence counts 0.5); ties → flagged.
//   reliabilityWeighted  votes weighted by `weights` (Record<jurorVersionHash,
//                        number>, e.g. silver/gold agreement); a juror absent
//                        from `weights` defaults to weight 1; ties → flagged.
//
// Multilabel labels (arrays): voting rules go per-label — a label lands in
// the aggregate iff its (weighted) support exceeds HALF of the panel's total
// weight; exactly half is NOT a majority (excluded, deterministic, never
// flagged). unanimityOrFlag compares whole label SETS (order-insensitive).
// mean/median reject multilabel (non-numeric).
//
// Entropy: Shannon entropy (natural log) of the label distribution across
// jurors, normalized by ln(k) where k = number of DISTINCT labels observed —
// so 2 jurors split = 1.0, unanimous = 0.0. Multilabel entropy is computed
// over whole label-set signatures (panel-level disagreement). Entropy uses
// UNWEIGHTED juror counts under every rule (it measures panel disagreement,
// not the weighted verdict).
//
// Result: {label?, flagged?, entropy, perJuror} — perJuror echoes
// [{juror, label, confidence, weight}] for the disagreement view.
import { ConcordError } from "../core/errors.js";

const RULES = new Set([
  "majority",
  "mean",
  "median",
  "unanimityOrFlag",
  "confidenceWeighted",
  "reliabilityWeighted",
]);

function fail(message, details = {}) {
  throw new ConcordError("VALIDATION", message, details);
}

function normalize(outputsByJuror) {
  let list;
  if (Array.isArray(outputsByJuror)) {
    list = outputsByJuror.map((o, i) => {
      if (!o || typeof o !== "object") fail(`outputs[${i}] must be an object`, { index: i });
      if (o.juror === undefined || o.juror === null || o.juror === "")
        fail(`outputs[${i}] missing juror id`, { index: i });
      return {
        juror: String(o.juror),
        label: o.label,
        confidence: typeof o.confidence === "number" ? o.confidence : null,
      };
    });
  } else if (outputsByJuror && typeof outputsByJuror === "object") {
    list = Object.entries(outputsByJuror).map(([juror, o]) => {
      if (!o || typeof o !== "object")
        fail(`output for juror "${juror}" must be an object`, { juror });
      return {
        juror,
        label: o.label,
        confidence: typeof o.confidence === "number" ? o.confidence : null,
      };
    });
  } else {
    fail("outputsByJuror must be an array of outputs or a Record<juror, output>", {});
  }
  if (list.length === 0) fail("panel aggregation needs at least one juror output", {});
  const seen = new Set();
  for (const o of list) {
    if (seen.has(o.juror)) fail("duplicate juror in panel outputs", { juror: o.juror });
    seen.add(o.juror);
    if (o.label === undefined) fail("juror output missing label", { juror: o.juror });
  }
  return list;
}

// Canonical signature of a label for voting/entropy. Arrays (multilabel) sort
// first so ["a","b"] and ["b","a"] are the same set.
function sig(label) {
  if (Array.isArray(label)) return JSON.stringify([...label].map(String).sort());
  return typeof label === "string" ? label : JSON.stringify(label);
}

const isMultilabel = (list) => list.some((o) => Array.isArray(o.label));

function asNumber(label, juror) {
  const n = typeof label === "number" ? label : typeof label === "string" ? Number(label) : NaN;
  if (!Number.isFinite(n)) {
    fail("mean/median aggregation requires numeric labels", { juror, label });
  }
  return n;
}

// Shannon entropy over juror label counts, normalized by ln(k observed).
export function entropy(labels) {
  if (!Array.isArray(labels) || labels.length === 0)
    fail("entropy requires a non-empty array of labels", {});
  const counts = new Map();
  for (const l of labels) {
    const k = sig(l);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const k = counts.size;
  if (k <= 1) return 0;
  const n = labels.length;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log(p);
  }
  return h / Math.log(k);
}

// Weighted vote over scalar labels. Returns {label} or {flagged: true} on a
// tie for the top weight. The representative label of the winning signature
// is the first juror's original value (so numeric labels stay numeric).
function vote(list, weightOf) {
  const tally = new Map(); // sig → {weight, label}
  for (const o of list) {
    const k = sig(o.label);
    const cur = tally.get(k);
    const w = weightOf(o);
    if (cur) cur.weight += w;
    else tally.set(k, { weight: w, label: o.label });
  }
  let best = null;
  let tie = false;
  for (const entry of tally.values()) {
    if (best === null || entry.weight > best.weight + 1e-12) {
      best = entry;
      tie = false;
    } else if (Math.abs(entry.weight - best.weight) <= 1e-12) {
      tie = true;
    }
  }
  return tie ? { flagged: true } : { label: best.label };
}

// Per-label weighted majority for multilabel: a label is included iff its
// support strictly exceeds half the total panel weight.
function multilabelVote(list, weightOf) {
  const support = new Map(); // String(label) → {weight, label}
  let total = 0;
  for (const o of list) {
    const w = weightOf(o);
    total += w;
    const labels = Array.isArray(o.label) ? o.label : [o.label];
    const seen = new Set();
    for (const l of labels) {
      const k = String(l);
      if (seen.has(k)) continue; // a juror votes once per label
      seen.add(k);
      const cur = support.get(k);
      if (cur) cur.weight += w;
      else support.set(k, { weight: w, label: l });
    }
  }
  const out = [];
  for (const { weight, label } of support.values()) {
    if (weight > total / 2 + 1e-12) out.push(label);
  }
  out.sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
  return { label: out };
}

// aggregate(outputsByJuror, panelPayload, weights?) →
//   {label?, flagged?, entropy, perJuror}
export function aggregate(outputsByJuror, panelPayload, weights) {
  const rule = panelPayload?.aggregation;
  if (!RULES.has(rule)) {
    fail(`unknown aggregation rule "${rule}" — expected one of ${[...RULES].join(", ")}`, { rule });
  }
  const list = normalize(outputsByJuror);
  const w = weights ?? panelPayload?.weights;
  const multilabel = isMultilabel(list);

  const weightOf = {
    majority: () => 1,
    unanimityOrFlag: () => 1,
    mean: () => 1,
    median: () => 1,
    confidenceWeighted: (o) => {
      const c = o.confidence ?? 0.5;
      // parity with reliabilityWeighted: a negative weight would let a juror
      // vote AGAINST its own label. The validated pipeline clamps confidence
      // to [0,1] upstream, so this cannot fire there — but the asymmetry was a
      // latent bug for any caller handing aggregate() a raw confidence.
      if (!(c >= 0)) {
        fail("confidence weights must be numbers >= 0", { juror: o.juror, confidence: c });
      }
      return c;
    },
    reliabilityWeighted: (o) => {
      const v = w?.[o.juror];
      if (v !== undefined && (typeof v !== "number" || !(v >= 0))) {
        fail("reliability weights must be numbers >= 0", { juror: o.juror, weight: v });
      }
      return v ?? 1; // unknown juror → neutral weight, documented above
    },
  }[rule];

  const h = entropy(list.map((o) => o.label));
  const perJuror = list.map((o) => ({
    juror: o.juror,
    label: o.label,
    confidence: o.confidence,
    weight: weightOf(o),
  }));

  let verdict;
  if (rule === "mean" || rule === "median") {
    if (multilabel) fail("mean/median aggregation cannot apply to multilabel outputs", { rule });
    const nums = list.map((o) => asNumber(o.label, o.juror)).sort((a, b) => a - b);
    if (rule === "mean") {
      verdict = { label: nums.reduce((a, b) => a + b, 0) / nums.length };
    } else {
      const mid = nums.length >> 1;
      verdict = { label: nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2 };
    }
  } else if (rule === "unanimityOrFlag") {
    const first = sig(list[0].label);
    verdict = list.every((o) => sig(o.label) === first)
      ? { label: list[0].label }
      : { flagged: true };
  } else if (multilabel) {
    verdict = multilabelVote(list, weightOf);
  } else {
    verdict = vote(list, weightOf);
  }

  return { ...verdict, entropy: h, perJuror };
}
