// Gold sets: CRUD, sampling designs (SRS / stratified / uncertainty, π stored
// on every sample row), blind coding (next/label), agreement (HUMAN FIRST,
// machine second), adjudication, and same-process coder-session listeners.
//
// The uncodable channel: a coder may submit {uncodable: true} instead of a
// label (stored in coders[].uncodable, never in labels), which keeps the
// unit out of that coder's agreement rows — missing data, not forced noise.
// At adjudication, {exclude: true} removes a unit from the gold standard
// (goldset.excluded); goldLabelMap skips excluded units for every consumer,
// and both counts are disclosed in the report/certificate/methods prose.
//
// Blindness is enforced server-side and structurally: the coder-facing
// payloads are built by coderNextView/progressView, which only ever read the
// requesting coder's own labels and the unit text — machine outputs and other
// coders' labels are not even loaded on those paths.
//
// Artifact concurrency: gold/<id>.json is read-modified-written INSIDE the
// project's updateProject mutator, so concurrent label submissions from two
// coder listeners serialize on the per-slug lock (one writer per bundle).
import { rm } from "node:fs/promises";
import { ConcordError } from "../core/errors.js";
import { createGoldSet } from "../core/objects.js";
import { sha256 } from "../core/ids.js";
import { mulberry32 } from "../core/rng.js";
import { loadProject, updateProject } from "../core/store.js";
import * as ledger from "../core/ledger.js";
import * as engineMod from "../runs/engine.js";
import {
  findOr404, requireBody, pdirOf, readCorpusUnits, unitsById,
  goldsetFile, readGoldset, goldLabelMap, agreementReport, statValue,
  finalsOf, addSpend, writeJsonAtomic, readNdjson, runOutputsFile, finalJurorOf,
} from "./_shared.js";

// ------------------------------------------------------------ persistence

async function writeGoldset(slug, gs) {
  await writeJsonAtomic(goldsetFile(slug, gs.id), gs);
}

function metaOf(gs) {
  return {
    id: gs.id,
    constructId: gs.constructId,
    tier: gs.tier,
    design: gs.design,
    status: gs.status,
    n: gs.sample?.length ?? 0,
    coders: (gs.coders ?? []).map((c) => c.coderId),
    ...(gs.corpusId ? { corpusId: gs.corpusId } : {}),
    ...(gs.humanAgreement ? { humanAgreement: { percent: gs.humanAgreement.percent, kappa: gs.humanAgreement.kappa, alpha: gs.humanAgreement.alpha, n: gs.humanAgreement.n } } : {}),
    createdAt: gs.createdAt,
  };
}

// Mutate a goldset artifact + its project meta inside the project lock.
async function mutateGoldset(slug, goldsetId, mutator) {
  let result;
  await updateProject(slug, async (p) => {
    const meta = (p.goldsets ?? []).find((g) => g.id === goldsetId);
    if (!meta) throw new ConcordError("NOT_FOUND", `gold set '${goldsetId}' not found`, { goldsetId });
    const gs = await readGoldset(slug, goldsetId);
    result = (await mutator(gs, p)) ?? gs;
    await writeGoldset(slug, result);
    const i = p.goldsets.findIndex((g) => g.id === goldsetId);
    p.goldsets[i] = metaOf(result);
  });
  return result;
}

// ----------------------------------------------------------------- sampling

function seededShuffle(items, seedStr) {
  const rand = mulberry32(parseInt(sha256(String(seedStr)).slice(0, 8), 16));
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function srsSample(units, n, seed) {
  const take = Math.min(n, units.length);
  const pi = take / units.length;
  return seededShuffle(units, seed).slice(0, take).map((u) => ({ unitId: u.id, pi }));
}

// Proportional allocation (largest remainder) within meta-key strata;
// π is per-stratum: taken_h / N_h.
function stratifiedSample(units, n, by, seed) {
  const strata = new Map();
  for (const u of units) {
    const key = String(u.meta?.[by] ?? "");
    let s = strata.get(key);
    if (!s) strata.set(key, (s = []));
    s.push(u);
  }
  const entries = [...strata.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const total = units.length;
  const target = Math.min(n, total);
  const alloc = entries.map(([key, members]) => {
    const exact = (target * members.length) / total;
    return { key, members, take: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let assigned = alloc.reduce((s, a) => s + a.take, 0);
  for (const a of [...alloc].sort((x, y) => y.frac - x.frac)) {
    if (assigned >= target) break;
    if (a.take < a.members.length) {
      a.take += 1;
      assigned += 1;
    }
  }
  const sample = [];
  for (const a of alloc) {
    if (a.take === 0) continue;
    const pi = a.take / a.members.length;
    for (const u of seededShuffle(a.members, `${seed}|${a.key}`).slice(0, a.take)) {
      sample.push({ unitId: u.id, pi });
    }
  }
  return sample;
}

// Uncertainty: rank units by the current instrument's uncertainty using the
// most recent run's CACHED outputs (panel entropy, else 1 − confidence);
// without any outputs the ranking degrades to a seeded shuffle. π is recorded
// as n/N — the design field carries "uncertainty" so downstream consumers
// know these inclusion probabilities are nominal, not SRS.
async function uncertaintySample(project, gs, units, n, seed) {
  const score = new Map(); // unitId → uncertainty
  const instruments = (project.instruments ?? []).filter((i) => i.constructId === gs.constructId);
  const runs = (project.runs ?? [])
    .filter((r) => instruments.some((i) => i.id === r.instrumentId))
    .sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")));
  for (const run of runs) {
    const inst = instruments.find((i) => i.id === run.instrumentId);
    const outputs = await readNdjson(runOutputsFile(project.slug, run.id), {
      filter: (o) => o.juror === finalJurorOf(inst),
    }).catch(() => []);
    if (outputs.length === 0) continue;
    for (const o of outputs) {
      if (score.has(o.unitId)) continue;
      const u = typeof o.entropy === "number" ? o.entropy
        : typeof o.confidence === "number" ? 1 - o.confidence
          : 0.5;
      score.set(o.unitId, u);
    }
    break; // most recent run with outputs wins
  }
  const take = Math.min(n, units.length);
  const pi = take / units.length;
  const ranked = score.size > 0
    ? [...units].sort((a, b) => (score.get(b.id) ?? -1) - (score.get(a.id) ?? -1))
    : seededShuffle(units, seed);
  return ranked.slice(0, take).map((u) => ({ unitId: u.id, pi }));
}

// ----------------------------------------------------- blind coder helpers

function coderEntry(gs, coderId) {
  let entry = (gs.coders ?? []).find((c) => c.coderId === coderId);
  if (!entry) {
    entry = { coderId, blind: true, labels: {}, memos: {}, flagged: [], startedAt: new Date().toISOString(), finishedAt: null };
    gs.coders = gs.coders ?? [];
    gs.coders.push(entry);
  }
  return entry;
}

// A coder is finished with a unit by labeling it OR by marking it uncodable
// (coders[].uncodable — the explicit "can't code" disposition). done counts
// both; uncodable is also reported on its own so the screens can show it.
function progressView(gs, coderId) {
  const total = gs.sample?.length ?? 0;
  const entry = (gs.coders ?? []).find((c) => c.coderId === coderId);
  const uncodable = entry ? Object.keys(entry.uncodable ?? {}).length : 0;
  const done = (entry ? Object.keys(entry.labels ?? {}).length : 0) + uncodable;
  return { coderId, done, uncodable, total, remaining: total - done, flagged: entry?.flagged?.length ?? 0 };
}

// The blind payload: the requesting coder's progress, the codebook entry, and
// ONE unlabeled unit (id + text + source position — no metadata, no flags, no
// machine output, no other coder anywhere on this code path).
export async function coderNextView(slug, goldsetId, coderId) {
  const project = await loadProject(slug);
  findOr404(project.goldsets, goldsetId, "gold set");
  const gs = await readGoldset(slug, goldsetId);
  const entry = (gs.coders ?? []).find((c) => c.coderId === coderId);
  const finished = new Set([...Object.keys(entry?.labels ?? {}), ...Object.keys(entry?.uncodable ?? {})]);
  const nextId = (gs.sample ?? []).map((s) => s.unitId).find((id) => !finished.has(id)) ?? null;

  const construct = (project.constructs ?? []).find((c) => c.id === gs.constructId) ?? null;
  const codebook = construct ? {
    name: construct.name,
    type: construct.type,
    definition: construct.definition,
    criteria: construct.criteria,
    edgeCases: construct.edgeCases,
    ...(construct.categories ? { categories: construct.categories } : {}),
    ...(construct.scale ? { scale: construct.scale } : {}),
  } : null;

  if (!nextId) return { unit: null, construct: codebook, progress: progressView(gs, coderId) };
  const found = await unitsById(project, [nextId], { corpusId: gs.corpusId });
  const u = found.get(nextId);
  return {
    unit: u ? { id: u.id, text: u.text, pos: u.pos ?? null } : { id: nextId, text: null, pos: null },
    construct: codebook,
    progress: progressView(gs, coderId),
  };
}

// A submission is exactly one disposition: a label, or uncodable: true (the
// coder cannot honestly assign any category). Uncodable marks live in
// coders[].uncodable — NEVER in the labels map — so agreement statistics see
// an absent row (the stats engine's missing-data path) instead of a forced
// guess. The later submission wins either way: labeling clears a prior
// uncodable mark and vice versa.
export async function submitCoderLabel(slug, goldsetId, { coder, unitId, label, memo, flag, uncodable }) {
  if (!coder) throw new ConcordError("VALIDATION", "label submission requires a coder id", {});
  if (!unitId) throw new ConcordError("VALIDATION", "label submission requires a unitId", {});
  const hasLabel = !(label === undefined || label === null || label === "");
  if (uncodable && hasLabel) {
    throw new ConcordError("VALIDATION", "a submission is either a label or uncodable: true, not both", { unitId });
  }
  if (!uncodable && !hasLabel) {
    throw new ConcordError("VALIDATION", "label submission requires a label (or uncodable: true)", {});
  }
  let progress;
  await mutateGoldset(slug, goldsetId, (gs) => {
    if (!(gs.sample ?? []).some((s) => s.unitId === unitId)) {
      throw new ConcordError("VALIDATION", `unit '${unitId}' is not part of this gold set's sample`, { unitId });
    }
    const entry = coderEntry(gs, coder);
    if (uncodable) {
      entry.uncodable = entry.uncodable ?? {};
      entry.uncodable[unitId] = true;
      delete entry.labels[unitId];
    } else {
      entry.labels[unitId] = label;
      if (entry.uncodable) delete entry.uncodable[unitId];
    }
    if (memo !== undefined && memo !== null && memo !== "") {
      entry.memos = entry.memos ?? {};
      entry.memos[unitId] = memo;
    }
    if (flag) {
      entry.flagged = entry.flagged ?? [];
      if (!entry.flagged.includes(unitId)) entry.flagged.push(unitId);
    }
    if (Object.keys(entry.labels).length + Object.keys(entry.uncodable ?? {}).length >= (gs.sample?.length ?? 0)) {
      entry.finishedAt = new Date().toISOString();
    }
    if (gs.status === "sampling") gs.status = "coding";
    progress = progressView(gs, coder);
  });
  await ledger.append(pdirOf(slug), "human", "goldset.label", { goldsetId, coderId: coder, unitId }, {
    ...(uncodable ? { uncodable: true } : { label }),
    ...(flag ? { flagged: true } : {}),
  });
  return progress;
}

export async function coderProgressView(slug, goldsetId, coderId) {
  const gs = await readGoldset(slug, goldsetId);
  return progressView(gs, coderId);
}

// Restricted route table for the same-process coder listener (consumed by
// index.js startCoderListener). The coder id is BOUND at listener start; a
// body-supplied coder id is ignored on purpose.
export function coderRoutes(projectSlug, goldsetId, coderId) {
  return [
    {
      method: "GET",
      pattern: "/api/coder/next",
      handler: async () => coderNextView(projectSlug, goldsetId, coderId),
    },
    {
      method: "POST",
      pattern: "/api/coder/label",
      handler: async (req) => {
        const body = req.body ?? {};
        return submitCoderLabel(projectSlug, goldsetId, {
          coder: coderId, // bound, never trusted from the body
          unitId: body.unitId,
          label: body.label,
          memo: body.memo,
          flag: body.flag,
          uncodable: body.uncodable,
        });
      },
    },
    {
      method: "GET",
      pattern: "/api/coder/progress",
      handler: async () => coderProgressView(projectSlug, goldsetId, coderId),
    },
  ];
}

// ----------------------------------------------------------- coder sessions

const sessions = new Map(); // `${slug}|${goldsetId}|${coderId}` → {server, port, close}

// ------------------------------------------------------------------ routes

export default [
  {
    method: "GET",
    pattern: "/api/projects/:p/goldsets",
    handler: async (req, res, params) => (await loadProject(params.p)).goldsets ?? [],
  },
  {
    method: "POST",
    pattern: "/api/projects/:p/goldsets",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const body = requireBody(req, ["constructId"]);
      findOr404(project.constructs, body.constructId, "construct");
      const corpusId = body.corpusId ?? project.corpora?.[0]?.id;
      if (!corpusId) throw new ConcordError("VALIDATION", "gold sets need a corpus to sample from", {});
      findOr404(project.corpora, corpusId, "corpus");
      const gs = createGoldSet({ constructId: body.constructId, tier: body.tier, design: body.design });
      gs.corpusId = corpusId;
      gs.createdAt = new Date().toISOString();
      await writeGoldset(params.p, gs);
      await updateProject(params.p, (p) => {
        p.goldsets.push(metaOf(gs));
      });
      await ledger.append(pdirOf(params.p), "human", "goldset.created", {
        goldsetId: gs.id, constructId: gs.constructId,
      }, { tier: gs.tier, design: gs.design, corpusId });
      return gs;
    },
  },
  {
    method: "GET",
    pattern: "/api/projects/:p/goldsets/:id",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      findOr404(project.goldsets, params.id, "gold set");
      return readGoldset(params.p, params.id);
    },
  },
  {
    method: "PUT",
    pattern: "/api/projects/:p/goldsets/:id",
    handler: async (req, res, params) => {
      const body = requireBody(req);
      const allowed = ["sampling", "coding", "adjudicating", "complete"];
      if (body.status !== undefined && !allowed.includes(body.status)) {
        throw new ConcordError("VALIDATION", `status must be one of ${allowed.join(", ")}`, { status: body.status });
      }
      let completedNow = false;
      const gs = await mutateGoldset(params.p, params.id, (g) => {
        if (body.status !== undefined) {
          completedNow = body.status === "complete" && g.status !== "complete";
          g.status = body.status;
        }
      });
      if (completedNow) {
        await ledger.append(pdirOf(params.p), "human", "goldset.completed", { goldsetId: params.id, constructId: gs.constructId }, {});
      }
      return gs;
    },
  },
  {
    method: "DELETE",
    pattern: "/api/projects/:p/goldsets/:id",
    handler: async (req, res, params) => {
      await updateProject(params.p, (p) => {
        const i = (p.goldsets ?? []).findIndex((g) => g.id === params.id);
        if (i === -1) throw new ConcordError("NOT_FOUND", `gold set '${params.id}' not found`, { id: params.id });
        p.goldsets.splice(i, 1);
      });
      await rm(goldsetFile(params.p, params.id), { force: true }).catch(() => {});
      await ledger.append(pdirOf(params.p), "human", "goldset.deleted", { goldsetId: params.id }, {});
      return { deleted: params.id };
    },
  },
  {
    method: "POST",
    pattern: "/api/projects/:p/goldsets/:g/sample",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      findOr404(project.goldsets, params.g, "gold set");
      const body = requireBody(req, ["n"]);
      const design = body.design ?? "srs";
      if (!["srs", "stratified", "uncertainty"].includes(design)) {
        throw new ConcordError("VALIDATION", `unknown sampling design "${design}"`, { design });
      }
      const n = Number(body.n);
      if (!Number.isInteger(n) || n < 1) throw new ConcordError("VALIDATION", "n must be a positive integer", { n: body.n });

      const current = await readGoldset(params.p, params.g);
      const corpusId = body.corpusId ?? current.corpusId ?? project.corpora?.[0]?.id;
      const units = await readCorpusUnits(params.p, corpusId);
      if (units.length === 0) throw new ConcordError("VALIDATION", `corpus '${corpusId}' has no units`, { corpusId });

      const seed = `sample|${params.g}|${design}|${n}`;
      let sample;
      if (design === "srs") {
        sample = srsSample(units, n, seed);
      } else if (design === "stratified") {
        const by = body.strata?.by;
        if (!by) throw new ConcordError("VALIDATION", "stratified sampling requires strata: {by: <meta key>}", {});
        sample = stratifiedSample(units, n, by, seed);
      } else {
        sample = await uncertaintySample(project, current, units, n, seed);
      }

      const gs = await mutateGoldset(params.p, params.g, (g) => {
        g.design = design;
        if (design === "stratified") g.strata = { by: body.strata.by };
        g.corpusId = corpusId;
        g.sample = sample;
        g.status = "coding";
      });
      const pis = [...new Set(sample.map((s) => s.pi))];
      await ledger.append(pdirOf(params.p), "human", "goldset.sampled", { goldsetId: params.g, corpusId }, {
        design,
        n: sample.length,
        N: units.length,
        pi: pis.length === 1 ? pis[0] : { min: Math.min(...pis), max: Math.max(...pis) },
      });
      return { goldsetId: gs.id, design, n: sample.length, sample };
    },
  },
  {
    // The human queue (a disagreement-screen disposition): the unit joins the
    // sample as {pi: null, queued: true} — codable, adjudicable, READ BY
    // AGREEMENT, but never a DSL gold row (queued π-null rows are filtered at
    // the correction assembly point — routes/analyses.js goldFor — because the
    // π-weighted estimators throw on y-without-pi). Idempotent per unit.
    method: "POST",
    pattern: "/api/projects/:p/goldsets/:g/queue",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      findOr404(project.goldsets, params.g, "gold set");
      const body = requireBody(req, ["unitId"]);
      const current = await readGoldset(params.p, params.g);
      const found = await unitsById(project, [body.unitId], { corpusId: current.corpusId });
      if (!found.has(body.unitId)) {
        throw new ConcordError("NOT_FOUND", `unit '${body.unitId}' not found in this project's corpora`, { unitId: body.unitId });
      }
      let already = false;
      let n = 0;
      const gs = await mutateGoldset(params.p, params.g, (g) => {
        g.sample = g.sample ?? [];
        if (g.sample.some((s) => s.unitId === body.unitId)) {
          already = true;
        } else {
          g.sample.push({ unitId: body.unitId, pi: null, queued: true });
        }
        n = g.sample.length;
      });
      if (!already) {
        await ledger.append(pdirOf(params.p), "human", "goldset.sampled", { goldsetId: params.g }, {
          queuedUnit: body.unitId,
        });
      }
      return { goldsetId: gs.id, unitId: body.unitId, queued: true, n, ...(already ? { already: true } : {}) };
    },
  },
  {
    method: "GET",
    pattern: "/api/projects/:p/goldsets/:g/next",
    handler: async (req, res, params) => {
      const coder = req.query.coder;
      if (!coder) throw new ConcordError("VALIDATION", "next requires ?coder=<coderId>", {});
      return coderNextView(params.p, params.g, coder);
    },
  },
  {
    method: "POST",
    pattern: "/api/projects/:p/goldsets/:g/label",
    handler: async (req, res, params) => {
      const body = requireBody(req, ["coder", "unitId"]);
      return submitCoderLabel(params.p, params.g, body);
    },
  },
  {
    // HUMAN AGREEMENT FIRST: compute + persist + ledger the human report
    // before any machine output is even produced for comparison.
    method: "GET",
    pattern: "/api/projects/:p/goldsets/:g/agreement",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      findOr404(project.goldsets, params.g, "gold set");
      const gsBefore = await readGoldset(params.p, params.g);
      const construct = (project.constructs ?? []).find((c) => c.id === gsBefore.constructId) ?? null;
      const coders = (gsBefore.coders ?? []).filter((c) => Object.keys(c.labels ?? {}).length > 0);
      if (coders.length < 2) {
        throw new ConcordError("VALIDATION", "agreement needs at least two coders with labels", { coders: coders.length });
      }

      // ---- 1. the human report, persisted + ledgered BEFORE anything machine
      // Uncodable marks contribute NO row for that coder: an absent row is
      // the stats engine's missing-data path, so an uncodable unit can only
      // shrink n — it never forces a binary guess into the coefficients.
      const humanRows = [];
      for (const c of coders) {
        for (const [unitId, label] of Object.entries(c.labels)) {
          humanRows.push({ unitId, coder: c.coderId, value: statValue(label) });
        }
      }
      const humanAgreement = agreementReport(humanRows, construct, {
        pairCoders: coders.length === 2 ? [coders[0].coderId, coders[1].coderId] : undefined,
      });
      // Disclosure counts for the report, certificate and methods prose:
      // uncodableUnits = sample units ≥1 coder marked uncodable;
      // excludedFromAgreement = sample units with <2 codable labels (they
      // cannot form an agreement pair and are surfaced for adjudication).
      const allCoders = gsBefore.coders ?? [];
      let uncodableUnits = 0;
      let excludedFromAgreement = 0;
      for (const s of gsBefore.sample ?? []) {
        if (allCoders.some((c) => c.uncodable?.[s.unitId])) uncodableUnits += 1;
        if (allCoders.filter((c) => c.labels?.[s.unitId] !== undefined).length < 2) excludedFromAgreement += 1;
      }
      humanAgreement.uncodableUnits = uncodableUnits;
      humanAgreement.excludedFromAgreement = excludedFromAgreement;
      const gs = await mutateGoldset(params.p, params.g, (g) => {
        g.humanAgreement = humanAgreement;
        if (g.status === "coding") g.status = "adjudicating";
      });
      await ledger.append(pdirOf(params.p), "human", "goldset.agreement", { goldsetId: params.g }, {
        n: humanAgreement.n,
        percent: humanAgreement.percent,
        kappa: humanAgreement.kappa,
        alpha: humanAgreement.alpha,
        coders: coders.map((c) => c.coderId),
        ...(uncodableUnits > 0 ? { uncodableUnits } : {}),
        ...(excludedFromAgreement > 0 ? { excludedFromAgreement } : {}),
      });

      // ---- 2. machine comparison vs adjudicated-or-consensus gold
      const gold = goldLabelMap(gs);
      const perInstrument = [];
      if (gold.size > 0) {
        const found = await unitsById(project, [...gold.keys()], { corpusId: gs.corpusId });
        const goldUnits = [...found.values()];
        const instruments = (project.instruments ?? []).filter((i) => i.constructId === gs.constructId);
        for (const inst of instruments) {
          try {
            const eph = await engineMod.runEphemeral(project, inst, goldUnits);
            await addSpend(params.p, eph.cost?.actualUSD ?? 0);
            const finals = finalsOf(eph.outputs, inst);
            const rows = [];
            for (const [unitId, label] of gold) {
              const out = finals.get(unitId);
              if (!out || out.label === undefined) continue;
              rows.push({ unitId, coder: "gold", value: statValue(label) });
              rows.push({ unitId, coder: "machine", value: statValue(out.label) });
            }
            if (rows.length === 0) {
              perInstrument.push({ instrumentId: inst.id, name: inst.name, kind: inst.kind, level: inst.level, error: { code: "NO_OUTPUTS", message: "no comparable outputs" } });
              continue;
            }
            perInstrument.push({
              instrumentId: inst.id,
              name: inst.name,
              kind: inst.kind,
              level: inst.level,
              versionHash: inst.versionHash,
              agreement: agreementReport(rows, construct, { goldCoder: "gold", pairCoders: ["gold", "machine"] }),
            });
          } catch (err) {
            perInstrument.push({
              instrumentId: inst.id,
              name: inst.name,
              kind: inst.kind,
              level: inst.level,
              error: { code: err?.code ?? "ERROR", message: err?.message ?? String(err) },
            });
          }
        }
      }
      return { humanAgreement, perInstrument, goldLabeled: gold.size };
    },
  },
  {
    // Adjudication resolves a unit with exactly one of two dispositions:
    //   {label}          → the gold label (adjudicated[unitId] = label);
    //   {exclude: true}  → the unit leaves the gold standard (g.excluded,
    //                      an array of unit ids — the terminal state of the
    //                      uncodable channel). goldLabelMap skips excluded
    //                      units, so freeze/agreement/drift/DSL all drop
    //                      them at the single assembly point in _shared.js.
    // The dispositions are mutually exclusive per unit and the later call
    // wins: excluding withdraws a prior adjudicated label, and adjudicating
    // a label re-admits a previously excluded unit. Either disposition
    // counts as RESOLVED for status auto-completion.
    method: "POST",
    pattern: "/api/projects/:p/goldsets/:g/adjudicate",
    handler: async (req, res, params) => {
      const body = requireBody(req, ["unitId"]);
      const exclude = body.exclude === true;
      const hasLabel = !(body.label === undefined || body.label === null || body.label === "");
      if (exclude && hasLabel) {
        throw new ConcordError("VALIDATION", "adjudication takes either a label or exclude: true, not both", { unitId: body.unitId });
      }
      if (!exclude && !hasLabel) {
        throw new ConcordError("VALIDATION", "adjudication requires a label (or exclude: true)", {});
      }
      let completedNow = false;
      const gs = await mutateGoldset(params.p, params.g, (g) => {
        if (!(g.sample ?? []).some((s) => s.unitId === body.unitId)) {
          throw new ConcordError("VALIDATION", `unit '${body.unitId}' is not in this gold set's sample`, { unitId: body.unitId });
        }
        if (exclude) {
          g.excluded = g.excluded ?? [];
          if (!g.excluded.includes(body.unitId)) g.excluded.push(body.unitId);
          if (g.adjudicated) delete g.adjudicated[body.unitId];
        } else {
          g.adjudicated = g.adjudicated ?? {};
          g.adjudicated[body.unitId] = body.label;
          if (g.excluded) g.excluded = g.excluded.filter((u) => u !== body.unitId);
        }
        if (g.status === "coding") g.status = "adjudicating";
        const gold = goldLabelMap(g);
        const excludedSet = new Set(g.excluded ?? []);
        if ((g.sample ?? []).every((s) => gold.has(s.unitId) || excludedSet.has(s.unitId)) && g.status !== "complete") {
          g.status = "complete";
          completedNow = true;
        }
      });
      const pdir = pdirOf(params.p);
      await ledger.append(pdir, "human", "goldset.adjudicated", { goldsetId: params.g, unitId: body.unitId },
        exclude ? { excluded: true } : { label: body.label });
      if (completedNow) {
        await ledger.append(pdir, "human", "goldset.completed", { goldsetId: params.g, constructId: gs.constructId }, {
          n: gs.sample?.length ?? 0,
          ...(gs.excluded?.length ? { excluded: gs.excluded.length } : {}),
        });
      }
      return {
        status: gs.status,
        adjudicated: Object.keys(gs.adjudicated ?? {}).length,
        excluded: gs.excluded?.length ?? 0,
      };
    },
  },
  {
    // Same-process restricted listener for one blind coder (single-writer
    // bundle: the listener shares this process; it is a route gate, never a
    // second writing process).
    method: "POST",
    pattern: "/api/projects/:p/goldsets/:g/coder-session",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      findOr404(project.goldsets, params.g, "gold set");
      const body = requireBody(req, ["coderId"]);
      const key = `${params.p}|${params.g}|${body.coderId}`;
      const existing = sessions.get(key);
      if (existing) {
        return { url: existing.url, port: existing.port, coderId: body.coderId, existing: true };
      }
      const { startCoderListener } = await import("../index.js");
      const session = await startCoderListener(params.p, params.g, body.coderId);
      sessions.set(key, session);
      return { url: session.url, port: session.port, coderId: body.coderId };
    },
  },
  {
    method: "DELETE",
    pattern: "/api/projects/:p/goldsets/:g/coder-session",
    handler: async (req, res, params) => {
      const prefix = `${params.p}|${params.g}|`;
      const coderId = req.query.coderId;
      let closed = 0;
      for (const [key, session] of [...sessions.entries()]) {
        if (!key.startsWith(prefix)) continue;
        if (coderId && key !== `${prefix}${coderId}`) continue;
        await session.close();
        sessions.delete(key);
        closed++;
      }
      return { closed };
    },
  },
];
