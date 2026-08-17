// In-memory run telemetry for SSE ticks. State lives in a module-level Map
// (runId → state) updated by the run engine; it does NOT persist — a process
// restart simply re-tracks on the next executeRun. runState() is the read API
// the monitor SSE route polls.
//
// Lifecycle/hygiene: the engine calls clearRun(runId) when a run reaches
// `complete` or `failed` (state and tripwire are dropped — the Map must not
// grow without bound). `paused`/`aborted` runs keep their state: they are
// cheap and likely resumed soon; a resume re-tracks and replays persisted
// outputs anyway, so live consumers must read telemetry DURING the run
// (onTick/SSE), not after it ends.
//
// Warnings raised here:
//   degenerate-output  one label holds > 95% of outputs after ≥ 100 outputs
//                      (raised once per run).
//   drift              armDriftTripwire(runId, cfg) arms a gold re-judge: the
//                      engine pings driftTick() after every final output; at
//                      every `every` outputs the monitor re-judges up to 20
//                      sampled gold units via runEphemeral with a fresh
//                      drift-specific seedOffset (so the check NEVER reuses
//                      cached run outputs), inside the armed {dir} bundle (so
//                      its cache lands with the run's, never in the default
//                      projects dir), and warns when percent agreement with
//                      the gold labels drops more than `threshold` below the
//                      certificate's stored agreement.
import { ConcordError } from "../core/errors.js";
import { sha256 } from "../core/ids.js";
import { mulberry32 } from "../core/rng.js";

const DEGENERATE_SHARE = 0.95;
const DEGENERATE_MIN_OUTPUTS = 100;
const DRIFT_SAMPLE = 20;
// Ring-buffer cap on the per-run warnings array. One warning lands per
// quarantined unit, so a 10k mass-failure used to grow this unbounded — and
// runState() copies the whole array on every tick/SSE poll (O(n) per poll →
// O(n²) over the run). Keep the most recent WARNINGS_CAP; older ones are
// summarized in a single dropped-count marker so the UI can say "+N earlier".
const WARNINGS_CAP = 200;

const states = new Map(); // runId → state
const tripwires = new Map(); // runId → drift config

function blank(total) {
  return {
    done: 0,
    total,
    costUSD: 0,
    labelDist: {},
    warnings: [],
    warningsDropped: 0, // count evicted by the ring-buffer cap (oldest-first)
    escalations: 0,
    outputs: 0, // every line written (per-juror + aggregate); `done` counts units
  };
}

// Engine-facing: start (or re-arm after resume) tracking for a run.
export function track(runId, { total = 0, done = 0, costUSD = 0 } = {}) {
  const s = blank(total);
  s.done = done;
  s.costUSD = costUSD;
  states.set(runId, s);
  return s;
}

function stateOf(runId) {
  let s = states.get(runId);
  if (!s) {
    s = blank(0);
    states.set(runId, s);
  }
  return s;
}

const labelKey = (label) =>
  Array.isArray(label) ? JSON.stringify([...label].map(String).sort()) : String(label);

// Record one FINAL output for a unit (the judge line, or the aggregate line
// for panels) — drives done, labelDist, escalations, and the degenerate check.
export function recordOutput(runId, output) {
  const s = stateOf(runId);
  s.done += 1;
  s.outputs += 1;
  if (output && output.label !== undefined) {
    const k = labelKey(output.label);
    s.labelDist[k] = (s.labelDist[k] || 0) + 1;
  }
  if (output?.escalated) s.escalations += 1;

  if (s.done >= DEGENERATE_MIN_OUTPUTS && !s.degenerateWarned) {
    const counts = Object.values(s.labelDist);
    const total = counts.reduce((a, b) => a + b, 0);
    const max = counts.length ? Math.max(...counts) : 0;
    if (total > 0 && max / total > DEGENERATE_SHARE) {
      const label = Object.keys(s.labelDist).find((k) => s.labelDist[k] === max);
      s.degenerateWarned = true;
      warn(runId, {
        kind: "degenerate-output",
        message: `label ${label} accounts for ${Math.round((100 * max) / total)}% of ${total} outputs`,
        label,
        share: max / total,
      });
    }
  }
  return s;
}

// Record one QUARANTINED unit: it counts toward progress (the live bar must
// reach total) but never toward labelDist/escalations — the unit produced no
// verdict, so results and the label distribution exclude it.
export function recordQuarantine(runId) {
  const s = stateOf(runId);
  s.done += 1;
  return s;
}

export function addCost(runId, usd) {
  const s = stateOf(runId);
  s.costUSD = Math.round((s.costUSD + usd) * 1e6) / 1e6;
  return s;
}

export function warn(runId, warning) {
  const s = stateOf(runId);
  s.warnings.push(typeof warning === "string" ? { kind: "warning", message: warning } : warning);
  // Ring buffer: keep only the most recent WARNINGS_CAP. Evicting from the
  // FRONT bounds both the array and runState()'s per-poll copy; the running
  // dropped-count keeps the UI honest about how many earlier warnings exist.
  if (s.warnings.length > WARNINGS_CAP) {
    s.warningsDropped += s.warnings.length - WARNINGS_CAP;
    s.warnings.splice(0, s.warnings.length - WARNINGS_CAP);
  }
  return s;
}

// → {done, total, costUSD, labelDist, warnings, escalations, [warningsDropped]} | null
// warningsDropped is present only when the ring buffer has evicted at least one
// warning (it stays absent in the common case, so consumers asserting an exact
// warnings set are unaffected).
export function runState(runId) {
  const s = states.get(runId);
  if (!s) return null;
  return {
    done: s.done,
    total: s.total,
    costUSD: s.costUSD,
    labelDist: { ...s.labelDist },
    warnings: s.warnings.slice(),
    escalations: s.escalations,
    ...(s.warningsDropped > 0 ? { warningsDropped: s.warningsDropped } : {}),
  };
}

export function clearRun(runId) {
  states.delete(runId);
  tripwires.delete(runId);
}

// ---------------------------------------------------------------------------
// Drift tripwire
// ---------------------------------------------------------------------------

// goldOutputs: [{unit: Unit, label: Label}] — the certificate's gold units
// with their adjudicated labels (the route layer assembles them; tests inject
// directly). baseline defaults to the frozen certificate's stored percent
// agreement. `project` is required so the re-judge respects privacy gates.
// `dir` (optional) is the run's bundle root — the SAME dir the engine was
// given — so the re-judge's cache lands in the run's bundle instead of the
// default projects dir; omitted, the engine resolves projectsDir().
export function armDriftTripwire(
  runId,
  { project, goldOutputs, instrument, every = 2000, threshold = 0.15, baseline, dir } = {},
) {
  if (!Array.isArray(goldOutputs) || goldOutputs.length === 0) {
    throw new ConcordError(
      "VALIDATION",
      "armDriftTripwire requires goldOutputs: [{unit, label}]",
      {},
    );
  }
  if (!instrument)
    throw new ConcordError("VALIDATION", "armDriftTripwire requires the instrument", {});
  if (!project) throw new ConcordError("VALIDATION", "armDriftTripwire requires the project", {});
  const base = baseline ?? instrument.certificate?.agreement?.percent;
  if (typeof base !== "number") {
    throw new ConcordError(
      "VALIDATION",
      "armDriftTripwire needs a baseline agreement (certificate.agreement.percent or explicit baseline)",
      {},
    );
  }
  tripwires.set(runId, {
    project,
    goldOutputs,
    instrument,
    every: Math.max(1, every),
    threshold,
    baseline: base,
    dir,
    lastCheckAt: 0,
    checking: false,
  });
}

// Engine ping after each final output. Fires the gold re-judge when the run
// crosses an `every` boundary. Returns the warning it raised, or null.
export async function driftTick(runId) {
  const cfg = tripwires.get(runId);
  if (!cfg) return null;
  const s = stateOf(runId);
  if (cfg.checking || s.done < cfg.lastCheckAt + cfg.every) return null;
  cfg.checking = true;
  cfg.lastCheckAt = s.done;
  try {
    // Seeded SRS of up to 20 gold units (seed from runId + position: stable
    // for a given run/checkpoint, no Math.random).
    const rand = mulberry32(parseInt(sha256(`${runId}|drift|${s.done}`).slice(0, 8), 16));
    const pool = cfg.goldOutputs.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const sample = pool.slice(0, Math.min(DRIFT_SAMPLE, pool.length));

    // Dynamic import breaks the engine↔monitor cycle at module-load time.
    const { runEphemeral } = await import("./engine.js");
    // drift-specific seedOffset → cache-namespace separation: the re-judge
    // must reflect the model NOW, not cached calibration-era outputs. The
    // armed {dir} keeps the re-judge (and its cache writes) inside the run's
    // bundle dir rather than the default projects dir.
    const { outputs } = await runEphemeral(
      cfg.project,
      cfg.instrument,
      sample.map((g) => g.unit),
      {
        seedOffset: `drift:${runId}:${s.done}`,
        dir: cfg.dir,
      },
    );
    // one verdict per unit: the juror line, overridden by the aggregate line
    // when the instrument is a panel
    const byUnit = new Map(outputs.map((o) => [o.unitId, o]));
    for (const o of outputs) if (o.juror === "aggregate") byUnit.set(o.unitId, o);

    let agree = 0;
    let n = 0;
    for (const g of sample) {
      const o = byUnit.get(g.unit.id);
      if (!o || o.label === undefined) continue;
      n++;
      if (labelKey(o.label) === labelKey(g.label)) agree++;
    }
    if (n === 0) return null;
    const agreement = agree / n;
    if (cfg.baseline - agreement > cfg.threshold) {
      const warning = {
        kind: "drift",
        message: `gold agreement dropped to ${agreement.toFixed(2)} (certificate baseline ${cfg.baseline.toFixed(2)}) after ${s.done} outputs`,
        agreement,
        baseline: cfg.baseline,
        at: s.done,
      };
      warn(runId, warning);
      return warning;
    }
    return null;
  } finally {
    cfg.checking = false;
  }
}
