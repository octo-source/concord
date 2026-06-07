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
  findOr404, requireBody, pdirOf, readCorpusUnits, unitsById, metaColumnNames,
  goldsetFile, readGoldset, goldLabelMap, agreementReport, statValue,
  finalsOf, addSpend, writeJsonAtomic, readNdjson, runOutputsFile,
  validateName,
} from "./_shared.js";
import { finalJurorOfRun } from "../runs/engine.js";
import { bootstrapCI } from "../stats/boot.js";
import { krippendorffAlpha } from "../stats/agreement.js";

// ------------------------------------------------------------ persistence

async function writeGoldset(slug, gs) {
  await writeJsonAtomic(goldsetFile(slug, gs.id), gs);
}

function metaOf(gs) {
  return {
    id: gs.id,
    constructId: gs.constructId,
    name: gs.name ?? "",
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

// ------------------------------------------------- committed-work guard
//
// A gold set accumulates committed human work: per-coder labels and
// uncodable marks, adjudicated gold labels, and adjudicator exclusions.
// Resampling or deleting over any of it silently destroys coding progress
// (and a resample would leave orphaned labels corrupting agreement
// statistics), so both routes refuse with CONFIRM_REQUIRED (409) until the
// caller repeats the request with force — and a forced resample CLEARS the
// stale work before drawing.

function committedWork(gs) {
  let labels = 0;
  let coders = 0;
  for (const c of gs?.coders ?? []) {
    const done = new Set([...Object.keys(c.labels ?? {}), ...Object.keys(c.uncodable ?? {})]);
    labels += done.size;
    if (done.size > 0) coders += 1;
  }
  const adjudicated = Object.keys(gs?.adjudicated ?? {}).length;
  const excluded = (gs?.excluded ?? []).length;
  return {
    labels, coders, adjudicated, excluded,
    committed: labels + adjudicated + excluded > 0,
  };
}

// "10 human labels from 2 coders, 2 adjudications, and 1 exclusion" — only
// the parts that exist, real counts, correct plurals.
function describeWork(w) {
  const s = (n) => (n === 1 ? "" : "s");
  const parts = [];
  if (w.labels > 0) parts.push(`${w.labels} human label${s(w.labels)} from ${w.coders} coder${s(w.coders)}`);
  if (w.adjudicated > 0) parts.push(`${w.adjudicated} adjudication${s(w.adjudicated)}`);
  if (w.excluded > 0) parts.push(`${w.excluded} exclusion${s(w.excluded)}`);
  if (parts.length <= 2) return parts.join(" and ");
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

// Throws CONFIRM_REQUIRED (→ 409) naming what exists and what the act would
// do; detail carries the counts so clients can confirm with real numbers.
function requireForce(work, consequence) {
  throw new ConcordError(
    "CONFIRM_REQUIRED",
    `This gold set has ${describeWork(work)}. ${consequence}`,
    { labels: work.labels, coders: work.coders, adjudicated: work.adjudicated, excluded: work.excluded },
  );
}

// Auto-name a new gold set "Gold — <construct>", suffixing " (2)", " (3)"…
// when the base (or a prior suffix) is already taken by another gold set on
// the project. Names are labels for humans; the construct link is the real
// provenance, so a collision is cosmetic, not an error.
function uniqueGoldsetName(project, constructName) {
  const base = `Gold — ${constructName}`;
  const taken = new Set((project.goldsets ?? []).map((g) => g.name).filter(Boolean));
  if (!taken.has(base)) return base;
  for (let k = 2; ; k++) {
    const candidate = `${base} (${k})`;
    if (!taken.has(candidate)) return candidate;
  }
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

// Proportional allocation (largest remainder) within meta-key strata, with a
// MIN-1 floor: every non-empty stratum takes at least one unit, so the design
// actually guarantees the coverage the screens promise ("every <column> value
// appears"). The floor is funded by walking units back from the largest
// allocations, so big strata absorb the cost. π stays per-stratum taken_h/N_h
// — the floor changes take_h, never the π bookkeeping. When n cannot cover
// every stratum, refuse loudly rather than silently dropping strata.
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
  if (target < entries.length) {
    throw new ConcordError(
      "VALIDATION",
      `n = ${target} cannot cover the ${entries.length} "${by}" strata — raise n to at least ${entries.length} so every stratum appears`,
      { n: target, strata: entries.length, by },
    );
  }
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
  // min-1 floor: lift every zero-take stratum to one unit…
  for (const a of alloc) {
    if (a.take === 0) {
      a.take = 1;
      assigned += 1;
    }
  }
  // …and walk the surplus back from the largest allocations (ties resolve in
  // key order — deterministic for a given corpus and column).
  while (assigned > target) {
    let donor = null;
    for (const a of alloc) {
      if (a.take >= 2 && (donor === null || a.take > donor.take)) donor = a;
    }
    if (!donor) break; // every stratum at 1 → assigned === #strata ≤ target
    donor.take -= 1;
    assigned -= 1;
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
    // keyed on the hash the run RAN under — an unfrozen instrument edited
    // after the run must not silently empty the uncertainty candidate pool
    const fin = finalJurorOfRun(run, inst);
    const outputs = await readNdjson(runOutputsFile(project.slug, run.id), {
      filter: (o) => o.juror === fin,
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

// The blind payload: the requesting coder's progress, the codebook entry
// (including the construct's worked examples — authored codebook content the
// model coder already receives, so human coders read the same instrument),
// and ONE unlabeled unit (id + text + source position — no metadata, no
// flags, no machine output, no other coder anywhere on this code path).
//
// {queue: true} (the studio sprint's route) additionally returns `remaining`:
// the SAME blind fields ({id, text, pos}) for every unit still in this
// coder's queue, in sample order, so the in-app sprint can offer j/k travel
// without ever touching an unblinded unit source. The restricted coder
// listener keeps the lean one-unit contract.
export async function coderNextView(slug, goldsetId, coderId, { queue = false } = {}) {
  const project = await loadProject(slug);
  findOr404(project.goldsets, goldsetId, "gold set");
  const gs = await readGoldset(slug, goldsetId);
  const entry = (gs.coders ?? []).find((c) => c.coderId === coderId);
  const finished = new Set([...Object.keys(entry?.labels ?? {}), ...Object.keys(entry?.uncodable ?? {})]);
  const remainingIds = (gs.sample ?? []).map((s) => s.unitId).filter((id) => !finished.has(id));
  const nextId = remainingIds[0] ?? null;

  const construct = (project.constructs ?? []).find((c) => c.id === gs.constructId) ?? null;
  const codebook = construct ? {
    name: construct.name,
    type: construct.type,
    definition: construct.definition,
    criteria: construct.criteria,
    edgeCases: construct.edgeCases,
    ...(construct.examples?.length ? { examples: construct.examples } : {}),
    ...(construct.categories ? { categories: construct.categories } : {}),
    ...(construct.scale ? { scale: construct.scale } : {}),
  } : null;

  const progress = progressView(gs, coderId);
  if (!nextId) {
    return { unit: null, construct: codebook, progress, ...(queue ? { remaining: [] } : {}) };
  }
  const blindUnit = (id, u) => (u ? { id: u.id, text: u.text, pos: u.pos ?? null } : { id, text: null, pos: null });
  if (!queue) {
    const found = await unitsById(project, [nextId], { corpusId: gs.corpusId });
    return { unit: blindUnit(nextId, found.get(nextId)), construct: codebook, progress };
  }
  const found = await unitsById(project, remainingIds, { corpusId: gs.corpusId });
  const remaining = remainingIds.map((id) => blindUnit(id, found.get(id)));
  return { unit: remaining[0], construct: codebook, progress, remaining };
}

// New human verdicts must be utterable in the construct's label space — a
// typo'd gold label forks the category space for every downstream consumer
// (machine-vs-gold agreement, DSL correction, reliability). Categories
// validate by value (arrays element-wise for multilabel); continuous
// validates against the declared scale bounds; extraction and other free
// types stay unvalidated. Only NEW submissions pass through here — stored
// labels are never retro-validated.
function validateLabelForConstruct(construct, label, what = "label") {
  if (!construct) return;
  const cats = construct.categories;
  if (Array.isArray(cats) && cats.length > 0) {
    const values = cats.map((c) => String(c.value));
    for (const v of Array.isArray(label) ? label : [label]) {
      if (!values.includes(String(v))) {
        throw new ConcordError(
          "VALIDATION",
          `${what} "${v}" is not a category of "${construct.name}" — valid labels: ${values.join(", ")}`,
          { label: v, valid: values },
        );
      }
    }
    return;
  }
  if (construct.type === "continuous" && construct.scale) {
    const num = Number(label);
    const { min, max } = construct.scale;
    if (!Number.isFinite(num) || num < min || num > max) {
      throw new ConcordError(
        "VALIDATION",
        `${what} "${label}" is outside the scale of "${construct.name}" — enter a number between ${min} and ${max}`,
        { label, min, max },
      );
    }
  }
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
  await mutateGoldset(slug, goldsetId, (gs, p) => {
    if (!(gs.sample ?? []).some((s) => s.unitId === unitId)) {
      throw new ConcordError("VALIDATION", `unit '${unitId}' is not part of this gold set's sample`, { unitId });
    }
    if (!uncodable) {
      const construct = (p.constructs ?? []).find((c) => c.id === gs.constructId) ?? null;
      validateLabelForConstruct(construct, label, "label");
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
      const construct = findOr404(project.constructs, body.constructId, "construct");
      const corpusId = body.corpusId ?? project.corpora?.[0]?.id;
      if (!corpusId) throw new ConcordError("VALIDATION", "gold sets need a corpus to sample from", {});
      findOr404(project.corpora, corpusId, "corpus");
      const name = typeof body.name === "string" && body.name !== ""
        ? validateName(body.name, "name")
        : uniqueGoldsetName(project, construct.name);
      const gs = createGoldSet({ constructId: body.constructId, tier: body.tier, design: body.design, name });
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
    // The full artifact PLUS populationN — the corpus unit count behind the
    // sample, so screens can state "you code n of N; inclusion probabilities
    // make the statistics honest" instead of presenting the sample as the
    // whole corpus.
    method: "GET",
    pattern: "/api/projects/:p/goldsets/:id",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      findOr404(project.goldsets, params.id, "gold set");
      const gs = await readGoldset(params.p, params.id);
      const corpus = (project.corpora ?? []).find((c) => c.id === gs.corpusId);
      return { ...gs, populationN: corpus?.unitCount ?? null };
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
      // a rename is validated up front (1..120) but never ledgered — the name
      // is a human label, not a scientific act on the gold standard
      if (body.name !== undefined) validateName(body.name, "name");
      let completedNow = false;
      const gs = await mutateGoldset(params.p, params.id, (g) => {
        if (body.name !== undefined) g.name = body.name;
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
    // Destroys coded work, so a gold set carrying committed work demands
    // ?force=1 (DELETE bodies are awkward); fresh sets delete as before.
    method: "DELETE",
    pattern: "/api/projects/:p/goldsets/:id",
    handler: async (req, res, params) => {
      const force = req.query.force === "1" || req.query.force === "true";
      if (!force) {
        // tolerant read: a meta entry whose artifact is missing carries no
        // work to protect — the delete then proceeds and cleans it up
        const current = await readGoldset(params.p, params.id).catch(() => null);
        const work = committedWork(current);
        if (work.committed) requireForce(work, "Deleting this gold set discards them.");
      }
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
      // Overwriting g.sample silently destroys committed coding work and
      // leaves orphaned labels behind, so a worked gold set refuses to
      // resample until the request carries force: true (the forced path
      // clears the stale work below, inside the project lock).
      if (body.force !== true) {
        const work = committedWork(current);
        if (work.committed) requireForce(work, "Drawing a new sample discards them.");
      }
      // The gold set's OWN corpus is the unit source — never project.corpora[0].
      // A silent fallback to the first corpus would sample a different column's
      // text than the one under analysis and invalidate the calibration. So the
      // resolved corpus must still exist on the project; if it is gone, refuse
      // (400) and name it rather than swapping in corpora[0].
      const corpusId = body.corpusId ?? current.corpusId ?? project.corpora?.[0]?.id;
      if (!corpusId) throw new ConcordError("VALIDATION", "gold sets need a corpus to sample from", {});
      if (!(project.corpora ?? []).some((c) => c.id === corpusId)) {
        throw new ConcordError("VALIDATION",
          `gold set '${params.g}' samples corpus '${corpusId}', which is no longer in this project — re-import it or create a gold set on a current corpus`,
          { corpusId, goldsetId: params.g });
      }
      const units = await readCorpusUnits(params.p, corpusId);
      if (units.length === 0) throw new ConcordError("VALIDATION", `corpus '${corpusId}' has no units`, { corpusId });

      // The seed carries a persisted per-goldset draw counter so a redraw
      // with unchanged parameters actually draws a NEW sample (the discard
      // dialog says "drawing a new sample" — it must be true). Draw 0 omits
      // the salt, keeping first draws bit-identical to the historical seed.
      const drawIndex = Number.isInteger(current.sampleDraws) && current.sampleDraws > 0
        ? current.sampleDraws
        : 0;
      const seed = `sample|${params.g}|${design}|${n}${drawIndex > 0 ? `|draw${drawIndex}` : ""}`;
      let sample;
      if (design === "srs") {
        sample = srsSample(units, n, seed);
      } else if (design === "stratified") {
        const by = body.strata?.by;
        if (!by) throw new ConcordError("VALIDATION", "stratified sampling requires strata: {by: <meta key>}", {});
        // ANY real metadata column stratifies; a column the corpus does not
        // have would silently collapse everything into one "" stratum (an
        // SRS wearing a stratified label), so it is rejected by name with
        // the real columns listed.
        const known = metaColumnNames(units);
        if (!known.includes(by)) {
          throw new ConcordError(
            "VALIDATION",
            `"${by}" is not a metadata column of corpus '${corpusId}' — columns: ${known.join(", ") || "(none)"}`,
            { column: by, known },
          );
        }
        sample = stratifiedSample(units, n, by, seed);
      } else {
        sample = await uncertaintySample(project, current, units, n, seed);
      }

      let discarded = null; // counts cleared by a forced resample, for the ledger
      const gs = await mutateGoldset(params.p, params.g, (g) => {
        // force: clear the stale work BEFORE the new sample lands — counts are
        // re-taken here, inside the lock, so the ledger records what was
        // actually discarded even if labels arrived after the pre-check.
        if (body.force === true) {
          const work = committedWork(g);
          if (work.committed) {
            discarded = { labels: work.labels, coders: work.coders, adjudicated: work.adjudicated, excluded: work.excluded };
            for (const c of g.coders ?? []) {
              c.labels = {};
              c.uncodable = {};
              c.memos = {};
              c.flagged = [];
              c.finishedAt = null; // no longer finished relative to the new sample
            }
            g.adjudicated = {};
            g.excluded = [];
            delete g.humanAgreement; // measured the labels just discarded
          }
        }
        g.design = design;
        if (design === "stratified") g.strata = { by: body.strata.by };
        g.corpusId = corpusId;
        g.sample = sample;
        g.status = "coding";
        g.sampleDraws = drawIndex + 1; // salt for the NEXT draw with these params
      });
      const pis = [...new Set(sample.map((s) => s.pi))];
      if (discarded) {
        await ledger.append(pdirOf(params.p), "human", "goldset.resampled", { goldsetId: params.g, corpusId }, {
          discarded,
        });
      }
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
    // The studio sprint's unit source: blind by construction (coderNextView),
    // WITH the remaining-queue extension so the sprint can travel j/k without
    // an unblinded fetch. The restricted coder listener (coderRoutes above)
    // keeps the lean one-unit payload.
    method: "GET",
    pattern: "/api/projects/:p/goldsets/:g/next",
    handler: async (req, res, params) => {
      const coder = req.query.coder;
      if (!coder) throw new ConcordError("VALIDATION", "next requires ?coder=<coderId>", {});
      return coderNextView(params.p, params.g, coder, { queue: true });
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
      // Adjudicator-excluded units are out of the gold standard AND out of
      // every agreement statistic ("counts toward no agreement statistic and
      // no gold label") — drop their labels before anything is computed.
      const excludedIds = new Set(gsBefore.excluded ?? []);
      const coders = (gsBefore.coders ?? []).filter((c) =>
        Object.keys(c.labels ?? {}).some((unitId) => !excludedIds.has(unitId)));
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
          if (excludedIds.has(unitId)) continue;
          humanRows.push({ unitId, coder: c.coderId, value: statValue(label) });
        }
      }
      const humanAgreement = agreementReport(humanRows, construct, {
        pairCoders: coders.length === 2 ? [coders[0].coderId, coders[1].coderId] : undefined,
      });
      // Percentile bootstrap CI for the headline α over the same human rows
      // (boot.js resamples units; its default B bounds the work). Degenerate
      // row sets (too few units, too many degenerate replicates) simply carry
      // no interval — the point estimate stands alone.
      const alphaLevel = construct?.type === "ordinal" ? "ordinal"
        : construct?.type === "continuous" ? "interval" : "nominal";
      const order = construct?.categories?.map((c) => String(c.value));
      try {
        humanAgreement.ci = bootstrapCI(humanRows, (rows) => krippendorffAlpha(rows, {
          level: alphaLevel,
          ...(alphaLevel !== "nominal" && order ? { order } : {}),
        }), { seed: parseInt(sha256(`bootci|${params.g}`).slice(0, 8), 16) });
      } catch { /* no interval — never block the report */ }
      // Disclosure counts for the report, certificate and methods prose:
      // uncodableUnits = sample units ≥1 coder marked uncodable;
      // excludedFromAgreement = sample units with <2 codable labels (they
      // cannot form an agreement pair and are surfaced for adjudication).
      // Adjudicator-excluded units are out of both — they are disclosed by
      // the goldset's own excluded count, not double-counted here.
      const allCoders = gsBefore.coders ?? [];
      let uncodableUnits = 0;
      let excludedFromAgreement = 0;
      for (const s of gsBefore.sample ?? []) {
        if (excludedIds.has(s.unitId)) continue;
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
      const gs = await mutateGoldset(params.p, params.g, (g, p) => {
        if (!(g.sample ?? []).some((s) => s.unitId === body.unitId)) {
          throw new ConcordError("VALIDATION", `unit '${body.unitId}' is not in this gold set's sample`, { unitId: body.unitId });
        }
        if (!exclude) {
          // a typo'd gold label forks the category space downstream — refuse
          // anything the construct cannot utter (categories / scale bounds)
          const construct = (p.constructs ?? []).find((c) => c.id === g.constructId) ?? null;
          validateLabelForConstruct(construct, body.label, "adjudicated label");
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
        return {
          url: existing.url, port: existing.port, coderId: body.coderId, existing: true,
          ...(existing.lanUrl ? { lanUrl: existing.lanUrl } : {}),
        };
      }
      const { startCoderListener } = await import("../index.js");
      // share: true is the researcher's explicit opt-in to bind all
      // interfaces; the default stays loopback-only. A shared listener
      // reports lanUrl (the page on the machine's first external IPv4).
      const session = await startCoderListener(params.p, params.g, body.coderId, {
        host: body.share === true ? "0.0.0.0" : "127.0.0.1",
      });
      sessions.set(key, session);
      return {
        url: session.url, port: session.port, coderId: body.coderId,
        ...(session.lanUrl ? { lanUrl: session.lanUrl } : {}),
      };
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
