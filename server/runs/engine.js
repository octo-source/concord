// Run engine: executes an instrument over a corpus with checkpointing,
// content-addressed caching, budget caps, quarantine, and escalation.
//
// Persistence model (per the Wave-1 contract amendments): the Run object
// lives in project.runs[] and every status/checkpoint/cost mutation goes
// through store.updateProject (atomic, lock-serialized). Outputs are append-
// only NDJSON at <project>/runs/<runId>/outputs.ndjson — one line per unit
// per juror, plus a `juror: "aggregate"` line per unit for panels. Resume
// derives the done-set from outputs.ndjson, NOT from the checkpoint (the
// checkpoint is advisory UI state and may lag behind appends).
//
// Exactly-once: a unit is DONE when its final line exists (the single juror
// line for judge/dictionary instruments; the aggregate line for panels).
// Per-juror lines append as calls complete, so a crash between juror lines
// and the aggregate resumes by re-running only the missing jurors.
//
// Error taxonomy per unit:
//   SCHEMA_INVALID / PROVIDER_REFUSAL / TRUNCATED → the unit quarantines
//     (recorded on run.quarantine as {unitId, code, message}, no output line,
//     run continues).
//   PROVIDER_UNREACHABLE / RATE_LIMITED_EXHAUSTED (after Pool retries) → the
//     RUN pauses as resumable (status "paused", run.error recorded) — good
//     units are never quarantined for infrastructure faults.
//   Budget cap → status "aborted", resumable (re-executeRun continues once
//     the cap is raised).
//   Anything else → status "failed", error recorded, rethrown.
//
// Escalation predicate (evaluated on each unit's final output):
//   confidence < 0.6 | panel entropy > 0.7 | repairs > 0 | unit text length
//   > p99 of the run's unit lengths. Matching units are marked
//   escalated: true (the run's human-review queue). When the caller supplies
//   {escalate: async (unit, output) → replacement|null} (the Director's
//   second-opinion seam — the engine stays decoupled from server/director/),
//   a non-null replacement overwrites label/confidence/rationale on the
//   written line — still marked escalated: true, still keyed by the WORKER's
//   juror hash (resume semantics) — and its escalatedBy marker (escalate.js
//   sets "director") is copied through as structural provenance. A null
//   return means the Director reviewed and CONCURRED (escalate.js contract):
//   the engine stamps escalatedBy: "director-concurred" so a confirmed
//   verdict is distinguishable from never-reviewed (no escalator configured
//   leaves escalatedBy unset entirely).
//
// Escalation failure taxonomy (the second opinion itself failing must never
// reject the worker pool — a mid-flight rejection used to strand the run
// record at "running" while surviving workers kept dispatching paid calls):
//   PROVIDER_UNREACHABLE / PROVIDER_HTTP / RATE_LIMITED_EXHAUSTED → the RUN
//     pauses as resumable (the unit's final line is not appended, so resume
//     re-runs it off the cached worker verdicts and re-attempts only the
//     second opinion).
//   Anything else (REFUSAL/SCHEMA_INVALID/TRUNCATED, deterministic) → the
//     worker verdict stands, the line stays flagged by the predicate, an
//     escalation-failed warning lands in live telemetry, the run continues.
//
// Dictionary instruments run through the SAME outputs path at $0: units are
// scored locally via dictionary.score (no adapter, no pool, no cache misses
// to pay for). Label mapping by construct type is documented at
// dictionaryLabel() below. Dictionary outputs skip the escalation predicate
// (no confidence/repairs and a second opinion on a deterministic count is
// meaningless).
//
// Seeds: runEphemeral({seedOffset}) threads the offset into each judge call
// as req.seed AND into the cache namespace (snapshot + "#seed:" + offset), so
// stability reruns get distinct, *individually cached* output streams.
import path from "node:path";
import { ConcordError } from "../core/errors.js";
import {
  loadProject,
  updateProject,
  appendNdjson,
  readNdjson,
  projectsDir,
  projectDir,
} from "../core/store.js";
import * as ledger from "../core/ledger.js";
import * as cache from "../core/cache.js";
import { createRun as newRunObject, instrumentVersionHash } from "../core/objects.js";
import { getAdapter } from "../providers/registry.js";
import { Pool } from "../providers/base.js";
import { estimateRun, meter } from "../providers/costs.js";
import { judgeUnit } from "../instruments/judge.js";
import { aggregate } from "../instruments/panel.js";
import { score as dictScore } from "../instruments/dictionary.js";
import * as monitor from "./monitor.js";

const CHECKPOINT_EVERY = 25;
const DEFAULT_CONCURRENCY = 4;
const QUARANTINE_CODES = new Set(["SCHEMA_INVALID", "PROVIDER_REFUSAL", "TRUNCATED"]);
const PAUSE_CODES = new Set(["PROVIDER_UNREACHABLE", "RATE_LIMITED_EXHAUSTED"]);
// Director second-opinion faults that pause the RUN (resumable). Director
// calls are unpooled, so a single 429/5xx surfaces as PROVIDER_HTTP here —
// infrastructure-class, worth pausing for. Deterministic Director faults
// (refusal, schema, truncation) skip the second opinion instead: see the
// escalation failure taxonomy in the header.
const DIRECTOR_PAUSE_CODES = new Set([
  "PROVIDER_UNREACHABLE",
  "PROVIDER_HTTP",
  "RATE_LIMITED_EXHAUSTED",
]);

// Quarantine entries carry their reasons: {unitId, code, message} (message
// trimmed to ≤200 chars). A researcher staring at an empty preview or a
// shrunken run must see WHY units vanished — a bare id list told them
// nothing (June 2026 field bug: mass TRUNCATED quarantines read as "empty
// results"). Older run records persisted bare unitId strings; readers
// normalize on load (string → {unitId, code: null, message: null}) so legacy
// run.json / project.runs[] keep working. Dedupe is by unitId, first entry
// wins (parity with the old Set semantics).
const QUARANTINE_MESSAGE_MAX = 200;

const trimQuarantineMessage = (message) => {
  if (typeof message !== "string" || message === "") return null;
  return message.length > QUARANTINE_MESSAGE_MAX
    ? message.slice(0, QUARANTINE_MESSAGE_MAX)
    : message;
};

const quarantineEntry = (unitId, err) => ({
  unitId,
  code: typeof err?.code === "string" ? err.code : null,
  message: trimQuarantineMessage(err?.message),
});

export function normalizeQuarantine(list) {
  const byUnit = new Map();
  for (const entry of Array.isArray(list) ? list : []) {
    const e =
      typeof entry === "string"
        ? { unitId: entry, code: null, message: null }
        : {
            unitId: entry?.unitId,
            code: typeof entry?.code === "string" ? entry.code : null,
            message: trimQuarantineMessage(entry?.message),
          };
    if (typeof e.unitId !== "string" || e.unitId === "" || byUnit.has(e.unitId)) continue;
    byUnit.set(e.unitId, e);
  }
  return [...byUnit.values()];
}
const round6 = (x) => Math.round(x * 1e6) / 1e6;
const nowISO = () => new Date().toISOString();

const activeRuns = new Set(); // in-process double-execute guard

// ---------------------------------------------------------------- lookups

function findOrThrow(list, id, what) {
  const found = (list ?? []).find((x) => x.id === id);
  if (!found)
    throw new ConcordError("NOT_FOUND", `${what} '${id}' not found in project`, { id, what });
  return found;
}

function constructOf(project, instrument) {
  return findOrThrow(project.constructs, instrument.constructId, "construct");
}

// Jurors of an instrument: judge → itself; panel → each juror payload hashed
// (Output.juror and reliability weights key on that hash). Dictionary → [].
function jurorsOf(instrument) {
  if (instrument.kind === "judge") {
    return [{ hash: instrument.versionHash, payload: instrument.payload }];
  }
  if (instrument.kind === "panel") {
    const jurors = instrument.payload?.jurors;
    if (!Array.isArray(jurors) || jurors.length === 0) {
      throw new ConcordError("VALIDATION", "panel instrument has no jurors", {
        instrumentId: instrument.id,
      });
    }
    return jurors.map((j) => ({ hash: instrumentVersionHash(j), payload: j }));
  }
  if (instrument.kind === "dictionary") return [];
  throw new ConcordError(
    "VALIDATION",
    `instrument kind "${instrument.kind}" is not runnable by the engine`,
    {
      kind: instrument.kind,
      instrumentId: instrument.id,
    },
  );
}

// The juror key a RUN's final verdict lines carry. Non-panel lines are
// stamped with the hash the run STARTED under (run.versionHash): an unfrozen
// instrument's versionHash mutates on every edit and silver-tune, which would
// otherwise orphan a finished run's outputs — blank exports, empty analyses,
// and a resume that re-bills every unit because neither the done-set nor the
// cache keys match anymore. Panels key their final on the constant
// "aggregate" line (per-juror lines keep per-juror payload hashes), so they
// are untouched. Route modules that read a run's final outputs call THIS,
// never _shared.finalJurorOf(instrument), which keys the current hash.
export function finalJurorOfRun(run, instrument) {
  if (instrument.kind === "panel") return "aggregate";
  return run?.versionHash ?? instrument.versionHash;
}

// unitFilter v1: "meta.<key>=<value>" (string compare on String(meta[key])).
export function parseUnitFilter(filterStr) {
  if (filterStr === undefined || filterStr === null || filterStr === "") return null;
  const m = /^meta\.([^=]+)=(.*)$/.exec(filterStr);
  if (!m) {
    throw new ConcordError(
      "VALIDATION",
      `unitFilter must look like "meta.<key>=<value>", got "${filterStr}"`,
      { filterStr },
    );
  }
  const [, key, value] = m;
  return (u) => String(u?.meta?.[key]) === value;
}

async function loadUnits(pdir, corpusId, unitFilter) {
  const file = path.join(pdir, "corpora", corpusId, "units.ndjson");
  const filter = parseUnitFilter(unitFilter);
  return readNdjson(file, filter ? { filter } : {});
}

// Interpolated p99 of unit text lengths (linear quantile, so the longest
// unit of even a small corpus can exceed it when lengths vary).
function p99Length(units) {
  if (units.length === 0) return Infinity;
  const lens = units.map((u) => (u.text ?? "").length).sort((a, b) => a - b);
  const pos = 0.99 * (lens.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lens[lo] + (lens[hi] - lens[lo]) * (pos - lo);
}

// catalog pricing for a model on an adapter (id or snapshot match); $0 fallback.
// On a catalog FETCH failure for a non-local (priced) provider, the $0 fallback
// silently zeroes the whole run's metering — run.cost stays $0 and the cap
// never trips. We keep the $0 (metering must not crash on a catalog blip) but
// flag it via onCatalogFail so the caller can surface "cost tracking
// unavailable" instead of a misleading $0. Genuinely-free local providers
// (mock, ollama: capabilities().local) legitimately price at $0 and never warn.
async function pricingFor(adapter, model, { onCatalogFail } = {}) {
  try {
    const entries = await adapter.catalog();
    const hit = entries.find((e) => e.id === model || e.snapshot === model);
    return hit?.pricing ?? { inUSDper1M: 0, outUSDper1M: 0 };
  } catch (err) {
    let local = false;
    try {
      local = adapter.capabilities?.().local === true;
    } catch {
      /* default: treat as priced */
    }
    if (!local) onCatalogFail?.(err);
    return { inUSDper1M: 0, outUSDper1M: 0 };
  }
}

// ---------------------------------------------------------------- dictionary

// Dictionary → Output label mapping (documented policy):
//   multilabel  array of category names with a nonzero score (payload order).
//   binary      positive label iff ANY category scored > 0; labels are the
//               construct's two category values (else yes/no).
//   continuous  the SUM of category scores (a number).
//   nominal/ordinal  argmax category by score (first-in-payload tie-break);
//               all-zero units get the sentinel label "none".
// NOT_<cat> negation keys and the `empty` marker never count toward labels.
function dictionaryLabel(constructType, payload, scores, binaryOptions) {
  const cats = payload.categories.map((c) => c.name);
  const value = (name) => scores[name] ?? 0;
  if (constructType === "multilabel") {
    return cats.filter((c) => value(c) > 0);
  }
  if (constructType === "binary") {
    const any = cats.some((c) => value(c) > 0);
    return any ? binaryOptions[0] : binaryOptions[1];
  }
  if (constructType === "continuous") {
    return cats.reduce((sum, c) => sum + value(c), 0);
  }
  let best = null;
  for (const c of cats) {
    if (value(c) > 0 && (best === null || value(c) > value(best))) best = c;
  }
  return best ?? "none";
}

function binaryOptionsOf(construct) {
  return Array.isArray(construct.categories) && construct.categories.length === 2
    ? construct.categories.map((c) => String(c.value))
    : ["yes", "no"];
}

// ---------------------------------------------------------------- worker loop

// Bounded-concurrency unit loop; fn returning false stops all workers (in-
// flight units finish, no new units start).
//
// A THROW from fn stops every worker too — not just the one that threw. Without
// this, only Promise.all rejected: the caller saw the error, but the surviving
// workers kept pulling units and dispatching PAID provider calls long after,
// and on resume those still-running detached workers raced the new execution
// into duplicate final lines per unit. So a throw sets the same `stopped`
// flag a false return does, captures the FIRST error, lets the in-flight batch
// drain (every worker settles), and rethrows the captured error with its code
// intact — callers branch on PROVIDER_*/CONFIG_MISSING/etc. propagating. Net:
// at most (concurrency - 1) extra units already in flight finish; none are
// dispatched after the first throw resolves the in-flight batch.
async function forEachUnit(units, concurrency, fn) {
  let next = 0;
  let stopped = false;
  let firstError = null;
  const n = Math.max(1, Math.min(concurrency, units.length || 1));
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (!stopped) {
        const idx = next++;
        if (idx >= units.length) return;
        try {
          if ((await fn(units[idx])) === false) {
            stopped = true;
            return;
          }
        } catch (err) {
          // Stop the WHOLE pool on the first throw and remember it. Later
          // throws from the draining batch are dropped — the first fault is
          // the one the caller's taxonomy classifies.
          if (!stopped) {
            stopped = true;
            firstError = err;
          }
          return;
        }
      }
    }),
  );
  if (firstError !== null) throw firstError;
}

// ---------------------------------------------------------------- shared context

// Build the per-execution context shared by executeRun and runEphemeral.
async function buildContext(
  project,
  instrument,
  { seedOffset = null, concurrency = DEFAULT_CONCURRENCY, dir } = {},
) {
  const construct = constructOf(project, instrument);
  const jurors = jurorsOf(instrument);
  const pdir = projectDir(project.slug, dir ?? projectsDir());

  const adapters = new Map(); // provider → {adapter, pool, ledgerEvent}
  const ctx = {
    project,
    instrument,
    construct,
    jurors,
    pdir,
    seedOffset,
    concurrency,
    m: meter(),
    jurorInfo: new Map(),
    // Pricing-catalog fetch failures for priced providers, deduped by
    // provider+model: executeRunInner flushes these to monitor.warn (after it
    // tracks the run) so the run surfaces "cost tracking unavailable" instead
    // of a silent $0. runEphemeral has no monitor and ignores them.
    pricingWarnings: [],
  };
  const pricingWarned = new Set();
  for (const j of jurors) {
    const provider = j.payload?.provider;
    if (typeof provider !== "string" || provider === "") {
      throw new ConcordError("VALIDATION", "judge payload missing provider", {
        instrumentId: instrument.id,
      });
    }
    let entry = adapters.get(provider);
    if (!entry) {
      const { adapter, ledgerEvent } = getAdapter(project, provider);
      entry = { adapter, pool: new Pool({ concurrency }), ledgerEvent };
      adapters.set(provider, entry);
    }
    const snapshot = j.payload.snapshot ?? j.payload.model ?? "unpinned";
    const pricing = await pricingFor(entry.adapter, j.payload.model, {
      onCatalogFail: () => {
        const dedupeKey = `${provider}|${j.payload.model}`;
        if (pricingWarned.has(dedupeKey)) return;
        pricingWarned.add(dedupeKey);
        ctx.pricingWarnings.push({
          kind: "pricing-unavailable",
          message: `cost tracking unavailable — pricing catalog failed for ${provider}/${j.payload.model ?? "?"}; metered cost may read $0`,
          provider,
          model: j.payload.model ?? null,
        });
      },
    });
    ctx.jurorInfo.set(j.hash, {
      payload:
        seedOffset === null
          ? j.payload
          : { ...j.payload, params: { ...(j.payload.params ?? {}), seed: seedOffset } },
      // Meter EVERY provider attempt at the adapter seam, not the final
      // response at the callJuror site: schema-repair re-prompts and the
      // doubled-budget truncation retry bill real tokens, and a unit that
      // ultimately QUARANTINES (SCHEMA_INVALID after the repair budget) has
      // billed every one of its attempts — its spend must reach run.cost.
      // The seam is the only place the engine can see per-attempt usage:
      // judgeUnit (instruments/judge.js) narrows the provider response to
      // {label, ..., usage}, so the provider layer's attemptsUsage totals do
      // not survive the success path. Attempts that THREW without returning
      // a usage object are unmeterable (providers/base.js boundary).
      adapter: {
        complete: async (creq) => {
          const cres = await entry.adapter.complete(creq);
          ctx.m.add(cres.usage ?? { inputTokens: 0, outputTokens: 0 }, pricing);
          return cres;
        },
      },
      pool: entry.pool,
      pricing,
      // seed participates in the cache namespace: distinct seeds are distinct
      // measurements and must never alias each other's cached outputs.
      cacheSnapshot: seedOffset === null ? snapshot : `${snapshot}#seed:${seedOffset}`,
    });
  }
  ctx.privacyEvents = [...adapters.values()].map((e) => e.ledgerEvent).filter(Boolean);
  return ctx;
}

// Judge a unit with one juror: cache-first, then pooled model call.
// Returns the output line fields (without unitId). Throws taxonomy errors.
async function callJuror(ctx, jurorHash, unit) {
  const info = ctx.jurorInfo.get(jurorHash);
  const key = cache.key(unit.text, jurorHash, info.cacheSnapshot);
  const cached = await cache.get(ctx.pdir, key);
  if (cached) {
    const out = {
      juror: jurorHash,
      label: cached.label,
      rationale: cached.rationale,
      cacheHit: true,
    };
    if (typeof cached.confidence === "number") out.confidence = cached.confidence;
    if (cached.repairs > 0) out.repaired = true;
    out.repairs = cached.repairs ?? 0;
    return out;
  }
  // No ctx.m.add here: the juror's adapter (buildContext) already metered
  // every attempt as it returned — adding the final usage again would
  // double-count it.
  const res = await info.pool.run(() => judgeUnit(info.adapter, ctx.construct, info.payload, unit));
  await cache.put(ctx.pdir, key, {
    label: res.label,
    confidence: res.confidence,
    rationale: res.rationale,
    repairs: res.repairs,
  });
  const out = {
    juror: jurorHash,
    label: res.label,
    rationale: res.rationale,
    repairs: res.repairs,
  };
  if (typeof res.confidence === "number") out.confidence = res.confidence;
  if (res.repairs > 0) out.repaired = true;
  return out;
}

// Process one unit start-to-verdict. `have` = juror→output lines already on
// disk (resume). Returns {newLines, final, quarantined}; `final` carries the
// escalation-relevant fields. Taxonomy errors classified by the caller.
async function processUnit(ctx, unit, have = new Map()) {
  const { instrument } = ctx;

  if (instrument.kind === "dictionary") {
    const scores = dictScore([unit.text], instrument.payload)[0];
    const label = dictionaryLabel(
      ctx.construct.type,
      instrument.payload,
      scores,
      binaryOptionsOf(ctx.construct),
    );
    // the dictionary line IS the final line — the caller appends it once.
    // Persisted runs stamp the hash the run STARTED under (ctx.finalJurorHash,
    // see finalJurorOfRun); ephemeral callers keep the current hash.
    const final = {
      unitId: unit.id,
      juror: ctx.finalJurorHash ?? instrument.versionHash,
      label,
      scores,
    };
    return { newLines: [], final, quarantined: false };
  }

  const newLines = [];
  const outputs = []; // every juror's output (disk + fresh) for aggregation
  for (const j of ctx.jurors) {
    const prior = have.get(j.hash);
    if (prior) {
      outputs.push(prior);
      continue;
    }
    let out;
    try {
      out = await callJuror(ctx, j.hash, unit);
    } catch (err) {
      if (QUARANTINE_CODES.has(err?.code))
        return { newLines, final: null, quarantined: true, error: err };
      throw err; // pause/fail taxonomy is the caller's call
    }
    outputs.push(out);
    newLines.push({ unitId: unit.id, ...stripInternal(out) });
  }

  if (instrument.kind === "judge") {
    const only = outputs[0];
    const final = { unitId: unit.id, ...stripInternal(only), _repairs: only.repairs ?? 0 };
    // the judge line IS the final line: it was not appended yet (newLines
    // holds it) — the caller appends after the escalation decision.
    return { newLines: [], final, judgeLine: true, quarantined: false };
  }

  // panel: aggregate over all jurors (aggregate() falls back to
  // panelPayload.weights for the reliabilityWeighted rule)
  const agg = aggregate(
    outputs.map((o) => ({ juror: o.juror, label: o.label, confidence: o.confidence })),
    instrument.payload,
  );
  const final = { unitId: unit.id, juror: "aggregate", entropy: agg.entropy };
  if (agg.flagged) final.flagged = true;
  else final.label = agg.label;
  final._anyRepaired = outputs.some((o) => o.repaired === true || (o.repairs ?? 0) > 0);
  return { newLines, final, quarantined: false };
}

function stripInternal(out) {
  const { repairs: _repairs, ...rest } = out;
  return rest;
}

// Escalation predicate + optional Director second opinion. Mutates/replaces
// the final line; returns true when the unit escalated.
async function maybeEscalate(ctx, unit, final, { escalate, p99 }) {
  if (ctx.instrument.kind === "dictionary") return false;
  const lowConfidence = typeof final.confidence === "number" && final.confidence < 0.6;
  const highEntropy = typeof final.entropy === "number" && final.entropy > 0.7;
  const repaired = (final._repairs ?? 0) > 0 || final._anyRepaired === true;
  const tooLong = (unit.text ?? "").length > p99;
  if (!(lowConfidence || highEntropy || repaired || tooLong)) return false;

  final.escalated = true;
  if (typeof escalate === "function") {
    const replacement = await escalate(unit, cleanLine(final));
    if (replacement && typeof replacement === "object") {
      if (replacement.label !== undefined) {
        final.label = replacement.label;
        delete final.flagged;
      }
      if (replacement.confidence !== undefined) final.confidence = replacement.confidence;
      if (replacement.rationale !== undefined) final.rationale = replacement.rationale;
      // provenance: the line keeps the WORKER's juror hash (resume semantics
      // key on it) but carries the escalator's escalatedBy marker so a
      // Director override is structurally distinguishable downstream.
      if (replacement.escalatedBy !== undefined) final.escalatedBy = replacement.escalatedBy;
    } else {
      // The escalator contract (director/escalate.js) returns null when the
      // Director reviewed the unit and CONCURRED with the worker. Stamp that
      // provenance: a confirmed verdict must be distinguishable from a unit
      // nobody reviewed (no escalator configured leaves escalatedBy unset).
      final.escalatedBy = "director-concurred";
    }
  }
  return true;
}

function cleanLine(line) {
  const out = {};
  for (const [k, v] of Object.entries(line)) {
    if (k.startsWith("_") || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- createRun

// createRun(project, {instrumentId, corpusId, unitFilter?, capUSD?}) → run
// Validates instrument + corpus, computes the preflight estimate, persists
// the pending Run into project.runs via updateProject, ledgers run.preflight.
export async function createRun(
  project,
  { instrumentId, corpusId, unitFilter, capUSD, name } = {},
  { dir } = {},
) {
  const instrument = findOrThrow(project.instruments, instrumentId, "instrument");
  findOrThrow(project.corpora, corpusId, "corpus");
  constructOf(project, instrument); // must exist before any run is created
  const jurors = jurorsOf(instrument);

  const pdir = projectDir(project.slug, dir ?? projectsDir());
  const units = await loadUnits(pdir, corpusId, unitFilter);

  // identity fields on the run record
  let provider, model, snapshot, pinned;
  if (instrument.kind === "dictionary") {
    provider = "local";
    model = "dictionary";
    snapshot = instrument.versionHash;
    pinned = true;
  } else if (instrument.kind === "judge") {
    const p = instrument.payload;
    provider = p.provider;
    model = p.model;
    snapshot = p.snapshot ?? null;
    pinned = Boolean(p.snapshot);
  } else {
    const ps = instrument.payload.jurors;
    provider = [...new Set(ps.map((j) => j.provider))].join("+");
    model = ps.map((j) => j.model).join("+");
    snapshot = null;
    pinned = ps.every((j) => Boolean(j.snapshot));
  }

  // preflight estimate: sum per-juror estimates (each juror = 1 call/unit)
  let est = { calls: 0, inputTokens: 0, outputTokens: 0, estUSD: 0 };
  for (const j of jurors) {
    const { adapter } = getAdapter(project, j.payload.provider);
    const e = estimateRun({
      units,
      template: j.payload.promptTemplate ?? "",
      maxTokens: j.payload.params?.maxTokens ?? 256,
      pricing: await pricingFor(adapter, j.payload.model),
      concurrency: DEFAULT_CONCURRENCY,
    });
    est = {
      calls: est.calls + e.calls,
      inputTokens: est.inputTokens + e.inputTokens,
      outputTokens: est.outputTokens + e.outputTokens,
      estUSD: round6(est.estUSD + e.estUSD),
    };
  }

  const run = newRunObject({
    instrumentId,
    versionHash: instrument.versionHash,
    corpusId,
    ...(unitFilter !== undefined && unitFilter !== null ? { unitFilter } : {}),
    ...(typeof name === "string" && name !== "" ? { name } : {}),
    status: "pending",
    checkpoint: { done: 0, total: units.length },
    cost: { estUSD: est.estUSD, actualUSD: 0, inputTokens: 0, outputTokens: 0 },
    escalation: { count: 0, directorModel: project.director?.model ?? null },
    provider,
    model,
    snapshot,
    pinned,
  });
  run.capUSD = capUSD ?? null;

  await updateProject(
    project.slug,
    (p) => {
      if (!Array.isArray(p.runs)) p.runs = [];
      p.runs.push(run);
    },
    dir ?? projectsDir(),
  );

  await ledger.append(
    pdir,
    "system",
    "run.preflight",
    { runId: run.id, instrumentId, corpusId },
    {
      units: units.length,
      calls: est.calls,
      inputTokens: est.inputTokens,
      outputTokens: est.outputTokens,
      estUSD: est.estUSD,
    },
  );
  return run;
}

// ---------------------------------------------------------------- executeRun

function findRun(project, runId) {
  return findOrThrow(project.runs ?? [], runId, "run");
}

// The run fields the ENGINE owns and mutates during execution. persistRun
// copies ONLY these onto the disk record, leaving route-owned fields (name,
// pinned, capUSD, …) and identity fields (id, instrumentId, versionHash,
// corpusId, provider, model, snapshot, unitFilter) exactly as they sit on
// disk. labelDist/error/finishedAt/startedAt are conditionally present, so the
// in-place copy mirrors create/delete rather than blind assignment.
const ENGINE_OWNED_RUN_FIELDS = [
  "status",
  "checkpoint",
  "cost",
  "quarantine",
  "escalation",
  "startedAt",
  "finishedAt",
  "labelDist",
  "error",
];

// Persist mutable run fields (status/checkpoint/cost/quarantine/escalation/
// error/labelDist/startedAt/finishedAt) into project.runs via updateProject —
// IN PLACE, field by field. A whole-object `p.runs[i] = run` write reverted any
// concurrent route mutation of the same entry (a PUT /runs/:r rename setting
// run.name on disk, a pin toggle, a capUSD change) on the very next checkpoint,
// because the engine captured the run object once at executeRun entry and never
// saw the route's later write. Outputs never touch project.json.
async function persistRun(slug, run, dir) {
  await updateProject(
    slug,
    (p) => {
      const disk = (p.runs ?? []).find((r) => r.id === run.id);
      if (!disk)
        throw new ConcordError("NOT_FOUND", `run '${run.id}' vanished from project`, {
          runId: run.id,
        });
      for (const k of ENGINE_OWNED_RUN_FIELDS) {
        if (run[k] === undefined) delete disk[k];
        else disk[k] = run[k];
      }
    },
    dir,
  );
}

// executeRun(projectSlug, runId, {onTick?, shouldStop?, escalate?, capUSD?,
// concurrency?}) → run. Resumable: pending|paused|aborted|running(stale) all
// (re)start; complete returns as-is. Exactly-once via the outputs.ndjson
// done-set.
//
// shouldStop() is the external control seam (the routes layer's pause/abort
// buttons): it is probed at the top of every unit dispatch. Returning
// "pause" or "abort" stops dispatching; in-flight pool work drains (workers
// finish their current unit), then the engine itself writes the resumable
// paused/aborted status and returns the settled run — nothing appends after
// executeRun resolves. A user abort is NOT ledgered here (the caller owns
// that human event); only budget-cap aborts ledger system run.aborted.
export async function executeRun(projectSlug, runId, opts = {}) {
  const dir = opts.dir ?? projectsDir();
  const project = await loadProject(projectSlug, dir);
  const run = findRun(project, runId);
  if (run.status === "complete") return run;
  if (activeRuns.has(runId)) {
    throw new ConcordError("RUN_ACTIVE", `run '${runId}' is already executing in this process`, {
      runId,
    });
  }
  activeRuns.add(runId);
  try {
    return await executeRunInner(project, run, { ...opts, dir });
  } finally {
    activeRuns.delete(runId);
  }
}

async function executeRunInner(project, run, opts) {
  const slug = project.slug;
  const dir = opts.dir;
  const instrument = findOrThrow(project.instruments, run.instrumentId, "instrument");
  const ctx = await buildContext(project, instrument, {
    concurrency: opts.concurrency ?? DEFAULT_CONCURRENCY,
    dir,
  });
  const pdir = ctx.pdir;
  const outputsFile = path.join(pdir, "runs", run.id, "outputs.ndjson");

  // Pin the run to the version it STARTED under (see finalJurorOfRun): the
  // done-set, the cache keys and every new line key on run.versionHash, so an
  // instrument edit between sessions can neither blank a complete run's
  // outputs nor force a resume to re-bill finished units. Panels are
  // untouched: their finals key the constant "aggregate" line and per-juror
  // lines keep per-juror payload hashes.
  if (instrument.kind !== "panel") {
    const pinnedHash = run.versionHash ?? instrument.versionHash;
    ctx.finalJurorHash = pinnedHash;
    if (instrument.kind === "judge" && ctx.jurors[0]?.hash !== pinnedHash) {
      const j = ctx.jurors[0];
      const info = ctx.jurorInfo.get(j.hash);
      ctx.jurorInfo.delete(j.hash);
      ctx.jurorInfo.set(pinnedHash, info);
      ctx.jurors = [{ ...j, hash: pinnedHash }];
    }
  }

  const units = await loadUnits(pdir, run.corpusId, run.unitFilter);
  const p99 = p99Length(units);
  const capUSD = opts.capUSD ?? run.capUSD ?? null;

  // resume state from the outputs file: who already has which lines
  const existing = await readNdjson(outputsFile);
  const byUnit = new Map(); // unitId → Map(juror → output line)
  for (const line of existing) {
    let m = byUnit.get(line.unitId);
    if (!m) byUnit.set(line.unitId, (m = new Map()));
    m.set(line.juror, line);
  }
  const finalJuror = finalJurorOfRun(run, instrument);
  const isDone = (u) => byUnit.get(u.id)?.has(finalJuror) ?? false;
  const pending = units.filter((u) => !isDone(u));
  let done = units.length - pending.length;

  // Re-derive escalation.count from the persisted final lines, the SAME way the
  // done-set is derived. The live counter increments at each escalation and
  // persists only at checkpoints, so a crash between a checkpoint and the next
  // loses increments whose final lines DID durably land — and a plain resume
  // never recounted, so the summary undercounted. The replayed finals are the
  // source of truth: count those flagged escalated.
  if (!run.escalation || typeof run.escalation !== "object")
    run.escalation = { count: 0, directorModel: null };
  let escalatedSoFar = 0;
  for (const [, m] of byUnit) {
    const fin = m.get(finalJuror);
    if (fin?.escalated === true) escalatedSoFar += 1;
  }
  run.escalation.count = escalatedSoFar;

  // ledger + status: a resume is a fresh start event with resumed: true
  const resumed = run.status !== "pending";
  run.status = "running";
  if (!run.startedAt) run.startedAt = nowISO();
  run.checkpoint = { done, total: units.length };
  // normalize-on-read: legacy records carry bare unitId strings; also dedupes
  run.quarantine = normalizeQuarantine(run.quarantine);
  delete run.error;
  await persistRun(slug, run, dir);
  for (const ev of ctx.privacyEvents) {
    await ledger.append(pdir, ev.actor, ev.type, ev.refs, ev.payload);
  }
  await ledger.append(
    pdir,
    "system",
    "run.started",
    { runId: run.id, instrumentId: instrument.id, corpusId: run.corpusId },
    {
      total: units.length,
      resumed,
      pendingUnits: pending.length,
    },
  );

  // (re)track the monitor and replay already-persisted final lines so a
  // resumed run's labelDist/done/escalations are truthful from tick one.
  monitor.track(run.id, { total: units.length, costUSD: run.cost.actualUSD });
  // Surface any pricing-catalog failure from buildContext now that the run is
  // tracked (warning BEFORE track would be clobbered by track()'s blank state).
  for (const w of ctx.pricingWarnings) monitor.warn(run.id, w);
  for (const [, m] of byUnit) {
    const fin = m.get(finalJuror);
    if (fin) monitor.recordOutput(run.id, fin);
  }

  const base = { ...run.cost };
  const quarantine = new Map(run.quarantine.map((q) => [q.unitId, q])); // unitId → {unitId, code, message}
  const stop = { reason: null, error: null };
  let sinceCheckpoint = 0;

  const syncCost = () => {
    const t = ctx.m.totals();
    run.cost.actualUSD = round6(base.actualUSD + t.usd);
    run.cost.inputTokens = base.inputTokens + t.inputTokens;
    run.cost.outputTokens = base.outputTokens + t.outputTokens;
    monitor.addCost(run.id, run.cost.actualUSD - (monitor.runState(run.id)?.costUSD ?? 0));
  };

  // labelDist persists onto the run record at every checkpoint write and at
  // completion: the monitor already aggregates it (replayed from disk on
  // resume), and downstream planners (calibration's planning-pe) read
  // run.labelDist — a monitor-only distribution vanished with the process.
  const syncLabelDist = () => {
    run.labelDist = monitor.runState(run.id)?.labelDist ?? run.labelDist ?? {};
  };

  const checkpoint = async () => {
    run.checkpoint = { done, total: units.length };
    run.quarantine = [...quarantine.values()];
    syncLabelDist();
    syncCost();
    await persistRun(slug, run, dir);
  };

  await forEachUnit(pending, ctx.concurrency, async (unit) => {
    if (stop.reason) return false;
    const control = opts.shouldStop?.();
    if (control === "pause" || control === "abort") {
      stop.reason = control === "abort" ? "user-abort" : "user-pause";
      return false;
    }
    syncCost();
    if (capUSD !== null && run.cost.actualUSD >= capUSD) {
      stop.reason = "aborted";
      return false;
    }
    let result;
    try {
      result = await processUnit(ctx, unit, byUnit.get(unit.id));
    } catch (err) {
      if (PAUSE_CODES.has(err?.code)) {
        stop.reason = "paused";
        stop.error = err;
        return false;
      }
      stop.reason = "failed";
      stop.error = err;
      return false;
    }
    for (const line of result.newLines) {
      await appendNdjson(outputsFile, cleanLine(line));
    }
    if (result.quarantined) {
      quarantine.set(unit.id, quarantineEntry(unit.id, result.error));
      done += 1; // quarantined units count as handled for progress purposes
      monitor.recordQuarantine(run.id); // …and the LIVE bar must reach total too
      monitor.warn(run.id, {
        kind: "quarantine",
        message: `unit ${unit.id} quarantined: ${result.error?.code}`,
        unitId: unit.id,
        code: result.error?.code ?? null,
      });
    } else {
      const final = result.final;
      let escalated;
      try {
        escalated = await maybeEscalate(ctx, unit, final, { escalate: opts.escalate, p99 });
      } catch (err) {
        // The Director's second opinion failed — classify INSIDE the per-unit
        // taxonomy so the worker pool never rejects (see the header contract).
        if (DIRECTOR_PAUSE_CODES.has(err?.code)) {
          // infrastructure fault → the RUN pauses, resumable: this unit's
          // final line is not appended, so resume re-runs it off the cached
          // worker verdicts and re-attempts only the second opinion
          stop.reason = "paused";
          stop.error = err;
          return false;
        }
        // deterministic fault → the worker verdict stands; the line stays
        // flagged by the predicate, and the failure is visible in telemetry
        escalated = final.escalated === true;
        monitor.warn(run.id, {
          kind: "escalation-failed",
          message: `unit ${unit.id}: Director second opinion failed (${err?.code ?? "ERROR"}) — the worker verdict stands`,
          unitId: unit.id,
          code: err?.code ?? null,
        });
      }
      if (escalated) run.escalation.count += 1;
      await appendNdjson(outputsFile, cleanLine(final));
      // This unit just produced a durable verdict line. If a PRIOR session
      // quarantined it (a transient that has since cleared on resume), drop the
      // stale quarantine entry: otherwise the unit ends with BOTH a verdict
      // line AND a quarantine entry, and results/exports that exclude
      // quarantined units would vanish a verdicted unit while run.completed
      // ledgers a phantom quarantined count.
      quarantine.delete(unit.id);
      done += 1;
      monitor.recordOutput(run.id, final);
    }
    syncCost();
    opts.onTick?.(monitor.runState(run.id));
    // The drift tripwire re-judges gold via an internal runEphemeral that
    // RETHROWS provider faults (PROVIDER_UNREACHABLE / RATE_LIMITED_EXHAUSTED).
    // A drift check is a MONITORING side-channel on calibrated runs — a
    // transient fault during it must never reject the worker pool (bug-1's
    // cascade) and must never fail the run. So: a PAUSE-class fault pauses the
    // run resumably (the same path a unit pause takes — resume re-checks
    // drift); ANY other fault warns and the run CONTINUES (a broken drift check
    // is not a reason to abandon the verdicts).
    try {
      await monitor.driftTick(run.id);
    } catch (err) {
      if (PAUSE_CODES.has(err?.code)) {
        stop.reason = "paused";
        stop.error = err;
        return false;
      }
      monitor.warn(run.id, {
        kind: "drift-failed",
        message: `drift re-judge failed (${err?.code ?? "ERROR"}) — the run continues; the drift check is unavailable`,
        code: err?.code ?? null,
      });
    }
    sinceCheckpoint += 1;
    if (sinceCheckpoint >= CHECKPOINT_EVERY) {
      sinceCheckpoint = 0;
      await checkpoint();
    }
    return true;
  });

  // terminal state
  syncCost();
  run.checkpoint = { done, total: units.length };
  run.quarantine = [...quarantine.values()];
  syncLabelDist();
  if (stop.reason === "failed") {
    run.status = "failed";
    run.error = {
      code: stop.error?.code ?? "UNKNOWN",
      message: stop.error?.message ?? String(stop.error),
    };
    await persistRun(slug, run, dir);
    monitor.clearRun(run.id); // failed runs clear their monitor state (see the complete-path note)
    throw stop.error;
  }
  if (stop.reason === "paused" || stop.reason === "user-pause") {
    run.status = "paused";
    // infra pauses carry their fault; a user pause is not an error
    if (stop.error) run.error = { code: stop.error.code, message: stop.error.message };
    await persistRun(slug, run, dir);
    return run;
  }
  if (stop.reason === "user-abort") {
    // the caller (routes layer) ledgers the human run.aborted event
    run.status = "aborted";
    await persistRun(slug, run, dir);
    return run;
  }
  if (stop.reason === "aborted") {
    run.status = "aborted";
    await persistRun(slug, run, dir);
    await ledger.append(
      pdir,
      "system",
      "run.aborted",
      { runId: run.id },
      {
        done,
        total: units.length,
        actualUSD: run.cost.actualUSD,
        capUSD,
      },
    );
    return run;
  }
  run.status = "complete";
  run.finishedAt = nowISO();
  await persistRun(slug, run, dir);
  await ledger.append(
    pdir,
    "system",
    "run.completed",
    { runId: run.id, instrumentId: instrument.id, corpusId: run.corpusId },
    {
      done,
      total: units.length,
      actualUSD: run.cost.actualUSD,
      quarantined: run.quarantine.length,
    },
  );
  if (run.escalation.count > 0) {
    await ledger.append(
      pdir,
      "system",
      "run.escalation_summary",
      { runId: run.id },
      {
        count: run.escalation.count,
        directorModel: run.escalation.directorModel,
      },
    );
  }
  // Monitor hygiene: clear this run's in-memory telemetry (and any armed
  // drift tripwire) now that the run is done — the module-level Map must not
  // grow without bound across runs. POLICY: complete and failed runs clear;
  // paused/aborted runs KEEP their state (cheap, and likely resumed soon —
  // though a resume re-tracks and replays persisted outputs regardless, so
  // clearing those too would also have been safe).
  monitor.clearRun(run.id);
  return run;
}

// ---------------------------------------------------------------- runEphemeral

// Same per-unit path (cache, pool, repair, quarantine) with NO persistence,
// NO ledger, NO monitor — silver tuning, stability reruns and previews.
// seedOffset → req.seed on every judge call + a distinct cache namespace.
// Budget cap → clean stop, partial results, aborted: true on the return.
// → {outputs, cost: {actualUSD, inputTokens, outputTokens},
//    quarantine: [{unitId, code, message}]}
export async function runEphemeral(project, instrument, units, opts = {}) {
  const ctx = await buildContext(project, instrument, {
    seedOffset: opts.seedOffset ?? null,
    concurrency: opts.concurrency ?? DEFAULT_CONCURRENCY,
    dir: opts.dir,
  });
  const capUSD = opts.capUSD ?? null;
  const outputs = [];
  const quarantine = [];
  let aborted = false;
  let done = 0;

  await forEachUnit(units, ctx.concurrency, async (unit) => {
    if (capUSD !== null && ctx.m.totals().usd >= capUSD) {
      aborted = true;
      return false;
    }
    // unreachable/rate-limit errors propagate: ephemeral callers fail loudly
    const result = await processUnit(ctx, unit);
    for (const line of result.newLines) outputs.push(cleanLine(line));
    if (result.quarantined) quarantine.push(quarantineEntry(unit.id, result.error));
    else outputs.push(cleanLine(result.final));
    done += 1;
    opts.onTick?.({ done, total: units.length, costUSD: ctx.m.totals().usd });
    return true;
  });

  const t = ctx.m.totals();
  const out = {
    outputs,
    cost: { actualUSD: round6(t.usd), inputTokens: t.inputTokens, outputTokens: t.outputTokens },
    quarantine,
  };
  if (aborted) out.aborted = true;
  return out;
}
