// Silver calibration: the Director labels a seeded sample once (silver gold
// set), then the worker's prompt is auto-tuned against those labels — run the
// worker over the sample, summarize the confusions, have the Director rewrite
// the template, repeat until agreement plateaus (≤ maxIterations, plateau =
// Δagreement < 0.01), then run the sibling stability check.
//
// Agreement scalar: the curve records PERCENT agreement vs the silver labels
// as `agreement` (it is total — never undefined mid-loop the way κ/α can be
// on degenerate intermediate label distributions); Cohen's κ and Krippendorff
// α are computed best-effort and recorded alongside for honesty. The plateau
// rule applies to the recorded agreement scalar.
//
// Cost channel: the result carries cost: {workerUSD, directorUSD} —
// workerUSD sums the tuning loop's runEphemeral spend (the stability check
// reports its own spend on its own return); directorUSD is the delta of the
// project's Director meter across the whole call (silver labels + rewrites).
// Every curve point carries costUSD: that ITERATION's spend, an iteration
// being (Director rewrite that produced its version + the worker pass) — the
// up-front silver labeling is deliberately not attributed to iteration 1.
//
// Budget: {capUSD} gates iterations AFTER the first — iteration 1 always
// runs (the silver labels are already paid for and one worker pass is the
// minimum useful calibration measurement). Before paying for the next
// iteration (rewrite + run), if accumulated silver spend (directorUSD so far
// + workerUSD so far) ≥ capUSD the loop stops cleanly: stoppedBy: "budget"
// on the result, a note on the last curve point, and the partial tune
// (goldset, curve so far, stability verdict, persistence) remains valid.
//
// Sibling dependencies are INJECTED per the pinned interface — tests pass
// doubles; production routes pass the real modules:
//   engine.runEphemeral(project, instrument, units, opts) → {outputs, cost, quarantine}
//   stability.stabilityCheck(project, instrument, units, {k, n}) → {alpha,
//     pass, runs, n?} (the real module returns the actual sample size n;
//     doubles may omit it)
import { ConcordError } from "../core/errors.js";
import { createGoldSet, versionInstrument } from "../core/objects.js";
import { updateProject, projectDir } from "../core/store.js";
import * as ledger from "../core/ledger.js";
import { cohenKappa, krippendorffAlpha } from "../stats/agreement.js";
import { callDirector, directorCosts, directorPool, seededSample, writeArtifact } from "./director.js";
import { silverLabelPrompt, confusionRewritePrompt, judgeResponseSchema, REWRITE_SCHEMA } from "./prompts.js";
import { enforceTemplateScaffolding } from "./compiler.js";

const labelKey = (v) => JSON.stringify(v);
const round6 = (x) => Math.round(x * 1e6) / 1e6;

// Top confusion cells (silver label vs worker label) with up to 3 example
// unit texts each — the evidence the Director reads before rewriting.
function confusionSummary(sample, silverLabels, workerByUnit) {
  const cells = new Map(); // "silver → worker" -> {count, examples}
  for (const u of sample) {
    const s = silverLabels[u.id];
    const w = workerByUnit.get(u.id);
    if (s === undefined || w === undefined) continue;
    if (labelKey(s) === labelKey(w.label)) continue;
    const key = `${labelKey(s)} → ${labelKey(w.label)}`;
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = { count: 0, examples: [] }));
    cell.count++;
    if (cell.examples.length < 3) cell.examples.push(u.text);
  }
  const top = [...cells.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 5);
  if (top.length === 0) return "(no confusions — worker and silver agree on every compared unit)";
  return top
    .map(([key, cell]) => {
      const ex = cell.examples.map((t) => `    e.g. "${String(t).slice(0, 240)}"`).join("\n");
      return `- silver ${key} by worker — ${cell.count} unit(s)\n${ex}`;
    })
    .join("\n");
}

// Best-effort κ/α between the silver coder and the worker on the compared
// units; degenerate distributions (single label, etc.) yield null, never a
// crash mid-loop.
function tryStats(sample, silverLabels, workerByUnit, construct) {
  const rows = [];
  for (const u of sample) {
    const s = silverLabels[u.id];
    const w = workerByUnit.get(u.id);
    if (s === undefined || w === undefined) continue;
    rows.push({ unitId: u.id, coder: "director", value: String(s) });
    rows.push({ unitId: u.id, coder: "worker", value: String(w.label) });
  }
  const order = construct.categories?.map((c) => String(c.value));
  let kappa = null;
  let alpha = null;
  try { kappa = cohenKappa(rows); } catch { /* degenerate → null */ }
  try {
    const level = construct.type === "ordinal" ? "ordinal" : construct.type === "continuous" ? "interval" : "nominal";
    alpha = krippendorffAlpha(rows, { level, ...(level !== "nominal" && order ? { order } : {}) });
  } catch { /* degenerate → null */ }
  return { kappa, alpha };
}

// silverTune(project, instrument, units, {engine, stability, onIteration, n,
// maxIterations, plateauDelta, capUSD})
// → {instrument, curve, cost: {workerUSD, directorUSD}, stoppedBy?: "budget"}
export async function silverTune(project, instrument, units, opts = {}) {
  const { engine, stability, onIteration, n = 200, maxIterations = 5, plateauDelta = 0.01, capUSD = null } = opts;
  if (!engine || typeof engine.runEphemeral !== "function") {
    throw new ConcordError("VALIDATION", "silverTune requires an injected engine ({runEphemeral}) — production routes pass server/runs/engine.js", {});
  }
  if (!stability || typeof stability.stabilityCheck !== "function") {
    throw new ConcordError("VALIDATION", "silverTune requires an injected stability checker ({stabilityCheck}) — production routes pass server/instruments/stability.js", {});
  }
  if (instrument.frozen) {
    throw new ConcordError("VALIDATION", "cannot silver-tune a frozen instrument — fork a new version first", { instrumentId: instrument.id });
  }
  if (!Array.isArray(units) || units.length === 0) {
    throw new ConcordError("VALIDATION", "silverTune needs units to sample from", {});
  }
  const construct = (project.constructs ?? []).find((c) => c.id === instrument.constructId);
  if (!construct) {
    throw new ConcordError("NOT_FOUND", `construct ${instrument.constructId} not found on the project`, { constructId: instrument.constructId });
  }

  const pdir = projectDir(project.slug);
  const directorUSDStart = directorCosts(project).usd; // meter delta isolates THIS tune's Director spend

  // ---- (1) Director silver-labels the seeded sample, one unit per call.
  // A few hundred frontier calls is the deliberate one-time cost of a
  // high-quality reference; the pool bounds provider pressure.
  const sample = seededSample(units, Math.min(n, units.length), `silver|${project.id}|${instrument.constructId}`);
  const pi = sample.length / units.length;
  const schema = judgeResponseSchema(construct);
  const pool = directorPool({ concurrency: 8 });
  const startedAt = new Date().toISOString();
  const labels = {};
  try {
    await Promise.all(sample.map((unit) => pool.run(async () => {
      const { system, user } = silverLabelPrompt(construct, unit);
      const res = await callDirector(project, {
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        schema,
        // reasoning-class Directors bill their thinking tokens against
        // max_tokens — 512 starved them before any JSON landed (June 2026
        // field failure); ≥1536 leaves room for thinking + the verdict.
        maxTokens: 1536,
      });
      labels[unit.id] = res.json.label;
    })));
  } catch (err) {
    // name the stage: a bare "raise maxTokens" pointed researchers at their
    // WORKER budgets while the Director's own labeling call was the one starving
    if (err instanceof Error) err.message = `Director silver-labeling: ${err.message}`;
    throw err;
  }
  const finishedAt = new Date().toISOString();

  const goldset = createGoldSet({
    constructId: construct.id,
    tier: "silver",
    design: "srs",
    sample: sample.map((u) => ({ unitId: u.id, pi })),
    coders: [{ coderId: "director", blind: true, labels, startedAt, finishedAt }],
    status: "complete",
  });
  await writeArtifact(pdir, `gold/${goldset.id}.json`, goldset);
  await updateProject(project.slug, (p) => {
    p.goldsets.push({
      id: goldset.id,
      constructId: construct.id,
      tier: "silver",
      design: "srs",
      status: "complete",
      n: sample.length,
      createdAt: startedAt,
    });
  });
  await ledger.append(pdir, "director", "goldset.created", { goldsetId: goldset.id, constructId: construct.id }, {
    tier: "silver", design: "srs", n: sample.length, pi,
  });
  await ledger.append(pdir, "director", "goldset.completed", { goldsetId: goldset.id, constructId: construct.id }, {
    tier: "silver", coder: "director",
  });

  // ---- (2) Tuning loop: run worker → compare → rewrite → re-version.
  const curve = [];
  let note = "initial template";
  let prevAgreement = null;
  let workerUSD = 0; // tuning-loop runEphemeral spend (stability reports its own)
  let stoppedBy = null;
  // per-iteration Director spend = meter delta between curve points; marked
  // AFTER silver labeling so the up-front labels are not billed to iteration 1
  let dirMark = directorCosts(project).usd;
  const accumulatedUSD = () => round6(workerUSD + (directorCosts(project).usd - directorUSDStart));
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const { outputs, cost: runCost } = await engine.runEphemeral(project, instrument, sample, { seedOffset: iteration });
    const iterWorkerUSD = runCost?.actualUSD ?? 0;
    workerUSD = round6(workerUSD + iterWorkerUSD);

    // prefer aggregate rows when a panel produced them; otherwise per-juror
    const workerByUnit = new Map();
    for (const o of outputs ?? []) {
      if (!workerByUnit.has(o.unitId) || o.juror === "aggregate") workerByUnit.set(o.unitId, o);
    }
    let compared = 0;
    let matched = 0;
    for (const u of sample) {
      const w = workerByUnit.get(u.id);
      if (w === undefined || labels[u.id] === undefined) continue;
      compared++;
      if (labelKey(w.label) === labelKey(labels[u.id])) matched++;
    }
    if (compared === 0) {
      throw new ConcordError("VALIDATION", "worker produced no comparable outputs over the silver sample", { iteration });
    }
    const agreement = matched / compared;
    const { kappa, alpha } = tryStats(sample, labels, workerByUnit, construct);
    // this iteration's spend: its worker pass + the Director rewrite that
    // produced its version (the meter delta since the previous curve point)
    const dirNow = directorCosts(project).usd;
    const point = { versionHash: instrument.versionHash, agreement, kappa, alpha, note, costUSD: round6(iterWorkerUSD + (dirNow - dirMark)) };
    dirMark = dirNow;
    curve.push(point);
    if (onIteration) await onIteration({ iteration, ...point });

    // plateau?
    if (prevAgreement !== null && Math.abs(agreement - prevAgreement) < plateauDelta) break;
    prevAgreement = agreement;
    if (iteration === maxIterations) break;

    // budget? an iteration is (Director rewrite + worker pass) — stop BEFORE
    // paying for the next one once accumulated silver spend reaches the cap.
    // The partial tune stays valid: stability + persistence still run below.
    if (capUSD !== null && accumulatedUSD() >= capUSD) {
      stoppedBy = "budget";
      point.note = `${point.note} — stopped: budget cap ($${capUSD}) reached`;
      break;
    }

    // confusion-driven rewrite → new instrument VERSION (unfrozen path resets
    // level and drops stale stability/silver — exactly right mid-loop)
    const summary = confusionSummary(sample, labels, workerByUnit);
    const { system, user } = confusionRewritePrompt({
      construct,
      currentTemplate: instrument.payload.promptTemplate,
      confusionSummary: summary,
      agreement,
    });
    let res;
    try {
      res = await callDirector(project, {
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        schema: REWRITE_SCHEMA,
        // thinking tokens bill against max_tokens on reasoning-class
        // Directors — keep the rewrite at the reasoning-tolerant floor (≥2048)
        maxTokens: 2048,
      });
    } catch (err) {
      if (err instanceof Error) err.message = `Director prompt-rewrite: ${err.message}`;
      throw err;
    }
    const newTemplate = enforceTemplateScaffolding(res.json.promptTemplate, instrument.payload.workerClass ?? "mid");
    versionInstrument(instrument, { ...instrument.payload, promptTemplate: newTemplate });
    note = res.json.note;
  }

  // ---- (3) Stability on the final version; pass + ≥1 silver iteration → ◑
  const stabRes = await stability.stabilityCheck(project, instrument, units, { k: 3, n: 100 });
  const { alpha: stabAlpha, pass } = stabRes;
  // record the check's ACTUAL n (the module caps at min(100, units.length)
  // and returns it); injected doubles without the field get the same cap
  instrument.stability = {
    alpha: stabAlpha, k: 3,
    n: stabRes.n ?? Math.min(100, units.length),
    ranAt: new Date().toISOString(),
  };
  instrument.silver = { goldsetId: goldset.id, iterations: curve };
  if (pass && curve.length >= 1) instrument.level = "stabilized";

  // persist the tuned instrument (upsert by id: silver-tuning an accepted
  // instrument updates it in place; tuning a not-yet-accepted one adds it)
  await updateProject(project.slug, (p) => {
    const i = p.instruments.findIndex((x) => x.id === instrument.id);
    if (i === -1) p.instruments.push(instrument);
    else p.instruments[i] = instrument;
  });
  await ledger.append(pdir, "director", "instrument.silver_tuned", {
    instrumentId: instrument.id, goldsetId: goldset.id,
  }, {
    iterations: curve.length,
    finalAgreement: curve[curve.length - 1].agreement,
    plateaued: stoppedBy === null && curve.length < maxIterations,
    versionHash: instrument.versionHash,
    ...(stoppedBy ? { stoppedBy } : {}),
  });
  // NOTE: the instrument.stability ledger event is appended by the stability
  // module itself (server/instruments/stability.js) — silverTune must NOT
  // re-append it, or one check would be double-counted by anything that
  // tallies stability runs from the ledger.

  const cost = {
    workerUSD: round6(workerUSD),
    directorUSD: round6(directorCosts(project).usd - directorUSDStart),
  };
  return { instrument, curve, cost, ...(stoppedBy ? { stoppedBy } : {}) };
}
