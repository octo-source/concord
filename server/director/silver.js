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
// Sibling dependencies are INJECTED per the pinned interface — tests pass
// doubles; production routes pass the real modules:
//   engine.runEphemeral(project, instrument, units, opts) → {outputs, cost, quarantine}
//   stability.stabilityCheck(project, instrument, units, {k, n}) → {alpha, pass, runs}
import { ConcordError } from "../core/errors.js";
import { createGoldSet, versionInstrument } from "../core/objects.js";
import { updateProject, projectDir } from "../core/store.js";
import * as ledger from "../core/ledger.js";
import { cohenKappa, krippendorffAlpha } from "../stats/agreement.js";
import { callDirector, directorPool, seededSample, writeArtifact } from "./director.js";
import { silverLabelPrompt, confusionRewritePrompt, judgeResponseSchema, REWRITE_SCHEMA } from "./prompts.js";
import { enforceTemplateScaffolding } from "./compiler.js";

const labelKey = (v) => JSON.stringify(v);

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
// maxIterations, plateauDelta}) → {instrument, curve}
export async function silverTune(project, instrument, units, opts = {}) {
  const { engine, stability, onIteration, n = 200, maxIterations = 5, plateauDelta = 0.01 } = opts;
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

  // ---- (1) Director silver-labels the seeded sample, one unit per call.
  // A few hundred frontier calls is the deliberate one-time cost of a
  // high-quality reference; the pool bounds provider pressure.
  const sample = seededSample(units, Math.min(n, units.length), `silver|${project.id}|${instrument.constructId}`);
  const pi = sample.length / units.length;
  const schema = judgeResponseSchema(construct);
  const pool = directorPool({ concurrency: 8 });
  const startedAt = new Date().toISOString();
  const labels = {};
  await Promise.all(sample.map((unit) => pool.run(async () => {
    const { system, user } = silverLabelPrompt(construct, unit);
    const res = await callDirector(project, {
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      schema,
      maxTokens: 512,
    });
    labels[unit.id] = res.json.label;
  })));
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
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const { outputs } = await engine.runEphemeral(project, instrument, sample, { seedOffset: iteration });

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
    const point = { versionHash: instrument.versionHash, agreement, kappa, alpha, note };
    curve.push(point);
    if (onIteration) await onIteration({ iteration, ...point });

    // plateau?
    if (prevAgreement !== null && Math.abs(agreement - prevAgreement) < plateauDelta) break;
    prevAgreement = agreement;
    if (iteration === maxIterations) break;

    // confusion-driven rewrite → new instrument VERSION (unfrozen path resets
    // level and drops stale stability/silver — exactly right mid-loop)
    const summary = confusionSummary(sample, labels, workerByUnit);
    const { system, user } = confusionRewritePrompt({
      construct,
      currentTemplate: instrument.payload.promptTemplate,
      confusionSummary: summary,
      agreement,
    });
    const res = await callDirector(project, {
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      schema: REWRITE_SCHEMA,
      maxTokens: 2048,
    });
    const newTemplate = enforceTemplateScaffolding(res.json.promptTemplate, instrument.payload.workerClass ?? "mid");
    versionInstrument(instrument, { ...instrument.payload, promptTemplate: newTemplate });
    note = res.json.note;
  }

  // ---- (3) Stability on the final version; pass + ≥1 silver iteration → ◑
  const { alpha: stabAlpha, pass } = await stability.stabilityCheck(project, instrument, units, { k: 3, n: 100 });
  instrument.stability = { alpha: stabAlpha, k: 3, n: 100, ranAt: new Date().toISOString() };
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
    plateaued: curve.length < maxIterations,
    versionHash: instrument.versionHash,
  });
  await ledger.append(pdir, "system", "instrument.stability", { instrumentId: instrument.id }, {
    alpha: stabAlpha, pass, k: 3, n: 100, versionHash: instrument.versionHash,
  });

  return { instrument, curve };
}
