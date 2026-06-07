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
// Alternate judges ({alts: [{provider, model, snapshot}]}, judge instruments
// only — the route validates): AFTER the k reruns, each alternate labels the
// SAME sampled units ONCE through the same compiled prompt/params/schema via
// the same runEphemeral path — only provider/model/snapshot swapped on a
// payload clone (its own versionHash, so cache namespaces never alias).
// alpha/pass stay own-model-reruns-only; a failing alternate is recorded as
// {provider, model, error} and never sinks the check.
//
// Ledger: appends `instrument.stability` to the project bundle (meta gains
// an alts summary — [{provider, model, n} | {provider, model, error}] — when
// alternates ran).
import { ConcordError } from "../core/errors.js";
import { sha256 } from "../core/ids.js";
import { mulberry32 } from "../core/rng.js";
import { projectsDir, projectDir } from "../core/store.js";
import * as ledger from "../core/ledger.js";
import { instrumentVersionHash } from "../core/objects.js";
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

// One alternate's labeled-output count for the ledger summary: judge lines
// only (alts are judge-only); flagged/no-label lines are missing data.
function labeledCount(outputs) {
  let n = 0;
  for (const o of outputs ?? []) {
    if (o.label === undefined || o.flagged) continue;
    n += 1;
  }
  return n;
}

// stabilityCheck(project, instrument, units, {k=3, n=100, alts?})
// → {alpha, pass, runs: [{seedOffset, outputs, cost, quarantine}],
//    alts?: [{provider, model, outputs, cost, quarantine}
//            | {provider, model, error}]}
export async function stabilityCheck(project, instrument, units, { k = 3, n = 100, dir, alts = null } = {}) {
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

  // ---- alternate judges: the same sample, the same compiled payload, ONCE
  // per model — only provider/model/snapshot overridden. The clone gets its
  // own versionHash so juror hashes and cache keys never alias the
  // instrument's own (the model IS part of instrument identity; an alt run
  // is a measurement beside the instrument, never a new version of it).
  let altRuns = null;
  if (Array.isArray(alts) && alts.length > 0) {
    altRuns = [];
    for (let i = 0; i < alts.length; i++) {
      const { provider, model, snapshot = null } = alts[i];
      const payload = { ...instrument.payload, provider, model, snapshot };
      const altInstrument = { ...instrument, payload, versionHash: instrumentVersionHash(payload) };
      try {
        const res = await runEphemeral(project, altInstrument, sample, { seedOffset: `stability:alt:${i}`, dir });
        altRuns.push({ provider, model, outputs: res.outputs, cost: res.cost, quarantine: res.quarantine });
      } catch (err) {
        // a broken alternate is a recorded result, not a sunk check
        altRuns.push({ provider, model, error: err?.message ?? String(err) });
      }
    }
  }

  const pdir = projectDir(project.slug, dir ?? projectsDir());
  await ledger.append(pdir, "system", "instrument.stability", { instrumentId: instrument.id }, {
    alpha, pass, k, n: sample.length, versionHash: instrument.versionHash,
    ...(altRuns ? {
      alts: altRuns.map((a) => (a.error !== undefined
        ? { provider: a.provider, model: a.model, error: a.error }
        : { provider: a.provider, model: a.model, n: labeledCount(a.outputs) })),
    } : {}),
  });

  return { alpha, pass, runs, ...(altRuns ? { alts: altRuns } : {}) };
}
