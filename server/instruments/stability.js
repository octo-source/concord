// Test–retest stability: run the instrument k times over a seeded SRS sample
// of units, treat the k runs as coders, and compute Krippendorff's α. An
// instrument that cannot agree with itself across reruns measures noise.
//
// Determinism: the sample is a seeded SRS (seed derived from the instrument's
// versionHash — no Math.random), and each rerun gets a DISTINCT seedOffset
// ("stability:<i>") so MockModel (which honors req.seed) produces genuinely
// decorrelated output streams instead of a vacuous α = 1. The engine threads
// the seedOffset into the cache namespace too, so reruns of the stability
// check itself are cached and free.
//
// Measurement level by construct type:
//   binary / nominal / multilabel / extraction → nominal α (multilabel and
//     extraction labels compare as canonical sorted-set signatures);
//   ordinal → interval α over the declared category order (order passed
//     through, indices form an equally-spaced scale);
//   continuous → interval α on the numeric labels.
//
// Degenerate edge: if every run emits one single identical category, α is
// formally undefined (no expected disagreement) — but the instrument was
// perfectly stable, so the check reports alpha = 1 rather than failing.
//
// Ledger: appends `instrument.stability` to the project bundle.
import { ConcordError } from "../core/errors.js";
import { sha256 } from "../core/ids.js";
import { mulberry32 } from "../core/rng.js";
import { projectsDir, projectDir } from "../core/store.js";
import * as ledger from "../core/ledger.js";
import { krippendorffAlpha } from "../stats/agreement.js";
import { runEphemeral } from "../runs/engine.js";

export const STABILITY_PASS_ALPHA = 0.8;

// Seeded SRS without replacement (partial Fisher–Yates).
function sampleUnits(units, n, seed) {
  const pool = units.slice();
  const rand = mulberry32(seed);
  const take = Math.min(n, pool.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rand() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, take);
}

function alphaValue(label) {
  if (Array.isArray(label)) return JSON.stringify([...label].map(String).sort());
  return label;
}

function alphaOptionsFor(construct) {
  if (construct.type === "ordinal") {
    const order = (construct.categories ?? []).map((c) => String(c.value));
    if (order.length === 0) {
      throw new ConcordError("VALIDATION", "ordinal construct needs categories for stability scoring", {
        constructId: construct.id,
      });
    }
    return { level: "interval", order };
  }
  if (construct.type === "continuous") return { level: "interval" };
  return { level: "nominal" };
}

// stabilityCheck(project, instrument, units, {k=3, n=100})
// → {alpha, pass, runs: [{seedOffset, outputs, cost, quarantine}]}
export async function stabilityCheck(project, instrument, units, { k = 3, n = 100, dir } = {}) {
  if (!Array.isArray(units) || units.length === 0) {
    throw new ConcordError("VALIDATION", "stabilityCheck requires a non-empty units array", {});
  }
  if (!Number.isInteger(k) || k < 2) {
    throw new ConcordError("VALIDATION", "stabilityCheck needs k >= 2 reruns", { k });
  }
  const construct = (project.constructs ?? []).find((c) => c.id === instrument.constructId);
  if (!construct) {
    throw new ConcordError("NOT_FOUND", `construct '${instrument.constructId}' not found in project`, {
      id: instrument.constructId,
    });
  }

  const seed = parseInt(sha256(`${instrument.versionHash}|stability`).slice(0, 8), 16);
  const sample = sampleUnits(units, Math.min(n, 100, units.length), seed);

  const finalJuror = instrument.kind === "panel" ? "aggregate" : null;
  const runs = [];
  const data = [];
  for (let i = 0; i < k; i++) {
    const seedOffset = `stability:${i}`;
    const res = await runEphemeral(project, instrument, sample, { seedOffset, dir });
    runs.push({ seedOffset, outputs: res.outputs, cost: res.cost, quarantine: res.quarantine });
    for (const out of res.outputs) {
      if (finalJuror !== null && out.juror !== finalJuror) continue; // panels: the aggregate verdict is the instrument's output
      if (out.label === undefined || out.flagged) continue; // flagged/quarantined → missing coding (absent row)
      data.push({ unitId: out.unitId, coder: `run${i}`, value: alphaValue(out.label) });
    }
  }

  let alpha;
  try {
    alpha = krippendorffAlpha(data, alphaOptionsFor(construct));
  } catch (err) {
    if (err?.code === "E_STAT_DEGENERATE") {
      // one single category everywhere = zero observed disagreement across
      // reruns: perfectly stable, just statistically degenerate
      alpha = 1;
    } else {
      throw err;
    }
  }
  const pass = alpha >= STABILITY_PASS_ALPHA;

  const pdir = projectDir(project.slug, dir ?? projectsDir());
  await ledger.append(pdir, "system", "instrument.stability", { instrumentId: instrument.id }, {
    alpha, pass, k, n: sample.length, versionHash: instrument.versionHash,
  });

  return { alpha, pass, runs };
}
