// The Director session: one sanctioned way to talk to the project's Director
// model. callDirector resolves the configured slot, routes through the
// provider registry (so privacy modes are enforced before any network object
// exists), demands a strict JSON schema (Director outputs are artifacts, and
// artifacts have shapes), and meters tokens/dollars into a per-project
// Director meter. It appends NOTHING to the ledger — callers ledger their own
// artifact events.
//
// project.director: {provider, model, snapshot, systemSuffix?}
//   systemSuffix (optional) is appended to the system message of every
//   Director call: researchers use it to customize the Director's standing
//   instructions; tests use it to carry MockModel [[handler:...]] markers.
import path from "node:path";
import { mkdir, open, rm } from "node:fs/promises";
import { ConcordError } from "../core/errors.js";
import { getAdapter } from "../providers/registry.js";
import { completeWithRepair, Pool, withTruncationRetry } from "../providers/base.js";
import { meter } from "../providers/costs.js";
import { renameWithRetry, readNdjson, projectDir } from "../core/store.js";
import { sha256 } from "../core/ids.js";
import { mulberry32 } from "../core/rng.js";

// ---------------------------------------------------------------- metering

// project.id → {meter, calls}. Module-level so every Director feature
// (brief, silver, panels, ...) accumulates into the same per-project meter.
const meters = new Map();

function meterFor(project) {
  const key = project.id ?? project.slug;
  let m = meters.get(key);
  if (!m) {
    m = { meter: meter(), calls: 0 };
    meters.set(key, m);
  }
  return m;
}

export function directorCosts(project) {
  const key = project.id ?? project.slug;
  const m = meters.get(key);
  if (!m) return { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
  const t = m.meter.totals();
  return { calls: m.calls, inputTokens: t.inputTokens, outputTokens: t.outputTokens, usd: t.usd };
}

// Pricing for the director model, looked up once per (provider, model) from
// the adapter's catalog. A failed catalog (e.g. Ollama offline) degrades to
// zero pricing — tokens are still metered, dollars read 0 for local backends
// anyway.
const pricingCache = new Map();

async function directorPricing(adapter, slot) {
  const key = `${slot.provider} ${slot.model}`;
  if (pricingCache.has(key)) return pricingCache.get(key);
  let pricing = { inUSDper1M: 0, outUSDper1M: 0 };
  try {
    const cat = await adapter.catalog();
    const entry = cat.find((m) => m.id === slot.model || m.snapshot === slot.model);
    if (entry?.pricing) pricing = entry.pricing;
  } catch {
    // unreachable catalog → keep zero pricing; the call itself will surface
    // any real connectivity problem
  }
  pricingCache.set(key, pricing);
  return pricing;
}

// ---------------------------------------------------------------- the call

const DEFAULT_MAX_TOKENS = 2048;

// The truncation retry now lives in the provider layer (providers/base.js) so
// judges share the policy without importing director code; re-exported here
// because existing call sites and tests import it from this module.
export { withTruncationRetry };

export async function callDirector(
  project,
  { messages, schema, maxTokens = DEFAULT_MAX_TOKENS, temperature = 0, seed } = {},
) {
  const slot = project?.director;
  if (!slot || !slot.provider || !slot.model) {
    throw new ConcordError(
      "CONFIG_MISSING",
      "No Director model is configured for this project. Open Settings → Director and choose a model " +
        "(in keyless demo mode, choose Mock). The Director drafts briefs, codebooks, and instruments for your review — it never bulk-codes your data.",
      { projectId: project?.id ?? null },
    );
  }
  if (!schema || typeof schema !== "object") {
    throw new ConcordError(
      "VALIDATION",
      "callDirector requires a strict response schema — every Director output is an artifact",
      {},
    );
  }
  if (!Array.isArray(messages)) {
    throw new ConcordError("VALIDATION", "callDirector requires a messages array", {});
  }

  // Privacy gates run inside getAdapter on EVERY call; in strict mode only
  // local backends (mock, ollama) ever construct. The returned ledgerEvent is
  // only non-null for no-training overrides, which are configured (and
  // ledgered) at settings time — the Director never self-authorizes one, so a
  // blocked director here throws rather than overriding.
  const { adapter } = getAdapter(project, slot.provider);

  // systemSuffix rides on the system message (appended, never prepended, so
  // researcher customization cannot displace the task instructions).
  const suffix = typeof slot.systemSuffix === "string" ? slot.systemSuffix : "";
  let finalMessages = messages;
  if (suffix) {
    const i = messages.findIndex((m) => m.role === "system");
    finalMessages =
      i === -1
        ? [{ role: "system", content: suffix }, ...messages]
        : messages.map((m, j) => (j === i ? { ...m, content: `${m.content}\n\n${suffix}` } : m));
  }

  // Meter EVERY provider attempt, not just the final response: schema-repair
  // re-prompts (completeWithRepair) and the doubled-budget truncation retry
  // each hit the provider and bill real tokens — metering only the winning
  // attempt under-reported Director spend whenever a call repaired. The
  // provider layer now does the accounting (providers/base.js): the response
  // carries attemptsUsage totals, and a call that throws after attempts
  // returned carries the same totals on err.details — so this is the ONE
  // metering site (the old per-attempt adapter wrapper is gone; keeping both
  // would double-count). Attempts that THREW without returning a usage object
  // remain unmeterable (the provider-layer boundary).
  const m = meterFor(project);
  const pricing = await directorPricing(adapter, slot);

  let res;
  try {
    res = await withTruncationRetry(
      (budget) =>
        completeWithRepair(adapter, {
          model: slot.model,
          messages: finalMessages,
          schema,
          temperature,
          maxTokens: budget,
          ...(seed !== undefined ? { seed } : {}),
        }),
      { maxTokens },
    );
  } catch (err) {
    const billed = err?.details?.attemptsUsage;
    if (billed) m.meter.add(billed, pricing); // failed calls still billed their returned attempts
    throw err;
  }

  m.meter.add(res.attemptsUsage ?? res.usage ?? { inputTokens: 0, outputTokens: 0 }, pricing);
  m.calls += 1; // one LOGICAL Director call, however many attempts it took
  return res;
}

// Bounded-concurrency helper for Director call fan-outs (silver labeling).
// One Pool per call site keeps provider pressure sane without a global queue.
export function directorPool({ concurrency = 8 } = {}) {
  return new Pool({ concurrency });
}

// ---------------------------------------------------------------- corpora

// Read a corpus's units for Director work. The corpus must be registered on
// the project (NOT_FOUND otherwise); an empty units file is a researcher-
// facing error, not a silent empty sample.
export async function readCorpusUnits(project, corpusId, { limit } = {}) {
  const meta = (project?.corpora ?? []).find((c) => c.id === corpusId);
  if (!meta) {
    throw new ConcordError("NOT_FOUND", `Corpus '${corpusId}' is not part of this project`, {
      corpusId,
    });
  }
  const file = path.join(projectDir(project.slug), "corpora", corpusId, "units.ndjson");
  const units = await readNdjson(file, limit ? { limit } : {});
  if (units.length === 0) {
    throw new ConcordError("VALIDATION", `Corpus '${corpusId}' has no units to read`, { corpusId });
  }
  return { meta, units };
}

// ---------------------------------------------------------------- sampling

// Deterministic sample of n items: seeded partial Fisher–Yates. Identical
// (items order, n, seedStr) → identical sample, so briefs and silver sets are
// reproducible from the bundle alone.
export function seededSample(items, n, seedStr) {
  if (n >= items.length) return [...items];
  const rand = mulberry32(parseInt(sha256(String(seedStr)).slice(0, 8), 16));
  const arr = [...items];
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rand() * (arr.length - i));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}

// ---------------------------------------------------------------- artifacts

let tmpSeq = 0;

// Atomic JSON artifact write (briefs/<id>.json, gold/<id>.json): unique tmp,
// fsync, rename — same recipe as core/store. Lives here because Director
// modules are the only Wave-2 writers of standalone artifact files.
export async function writeArtifact(projectDirPath, relPath, obj) {
  const file = path.join(projectDirPath, relPath);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${tmpSeq++}.tmp`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(JSON.stringify(obj, null, 2), "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await renameWithRetry(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return file;
}
