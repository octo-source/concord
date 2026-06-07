// Instruments: CRUD, Director re-compile, silver-tune (SSE), stability check,
// freeze (certificate minting — human agreement FIRST), and ephemeral preview.
//
// Seam conventions enforced here:
//   - silverTune gets the REAL modules injected: {engine: server/runs/engine,
//     stability: server/instruments/stability};
//   - no custom {dir} is ever passed to engine/director functions;
//   - budget: checkBudget at silver-tune start (400 BUDGET_EXCEEDED) and the
//     remaining headroom rides into the loop as its capUSD;
//   - cost roll-up: every runEphemeral/stability/silver/Director call adds to
//     project.budget.spentUSD.
import path from "node:path";
import { ConcordError } from "../core/errors.js";
import { sse } from "../router.js";
import { createInstrument, versionInstrument, freeze as freezeInstrument } from "../core/objects.js";
import { loadProject, updateProject } from "../core/store.js";
import { newId } from "../core/ids.js";
import * as ledger from "../core/ledger.js";
import { checkBudget } from "../providers/costs.js";
import * as engineMod from "../runs/engine.js";
import * as stabilityMod from "../instruments/stability.js";
import { hits as dictionaryHits } from "../instruments/dictionary.js";
import { silverTune } from "../director/silver.js";
import { compileInstrument, seedDictionary } from "../director/compiler.js";
import { seededSample } from "../director/director.js";
import {
  findOr404, requireBody, pdirOf, readCorpusUnits, unitsById, readGoldset,
  goldLabelMap, agreementReport, statValue, finalsOf, addSpend, withDirectorSpend, round6,
  writeJsonAtomic,
} from "./_shared.js";

function constructOf(project, instrument) {
  return findOr404(project.constructs, instrument.constructId, "construct");
}

// The persisted stability artifact: projects/<slug>/stability/<instrumentId>
// .json — ONE per instrument (a newer check overwrites the older). Carries
// the per-rerun labels the reliability route reads back as retest sources;
// the summary on instrument.stability stays exactly as before.
export function stabilityFile(slug, instrumentId) {
  return path.join(pdirOf(slug), "stability", `${instrumentId}.json`);
}

async function corpusUnitsFor(project, corpusId) {
  const id = corpusId ?? project.corpora?.[0]?.id;
  if (!id) throw new ConcordError("VALIDATION", "this project has no corpus yet", {});
  findOr404(project.corpora, id, "corpus");
  const units = await readCorpusUnits(project.slug, id);
  if (units.length === 0) throw new ConcordError("VALIDATION", `corpus '${id}' has no units`, { corpusId: id });
  return units;
}

function modelPinnedOf(instrument) {
  if (instrument.kind === "dictionary") return true;
  if (instrument.kind === "judge") return Boolean(instrument.payload.snapshot);
  if (instrument.kind === "panel") return (instrument.payload.jurors ?? []).every((j) => Boolean(j.snapshot));
  return false;
}

// Stability-check alternate judges: body.models must be an array of ≤4 plain
// objects with non-empty string provider/model (snapshot optional, string or
// null) — and only judge instruments take alternates (a dictionary has no
// model to swap; a panel's jurors are several models already). Returns the
// normalized [{provider, model, snapshot}] or null when none were requested.
const MAX_ALT_MODELS = 4;

function validateAltModels(models, instrument) {
  if (models === undefined) return null;
  if (!Array.isArray(models)) {
    throw new ConcordError("VALIDATION", "models must be an array of {provider, model} objects", { value: typeof models });
  }
  if (models.length === 0) return null;
  if (models.length > MAX_ALT_MODELS) {
    throw new ConcordError("VALIDATION", `at most ${MAX_ALT_MODELS} alternate judge models per stability check`, { count: models.length });
  }
  if (instrument.kind !== "judge") {
    throw new ConcordError("VALIDATION",
      `alternate judges apply to judge instruments — "${instrument.kind}" instruments have no single model to swap`,
      { kind: instrument.kind });
  }
  return models.map((m, i) => {
    if (m === null || typeof m !== "object" || Array.isArray(m)) {
      throw new ConcordError("VALIDATION", `models[${i}] must be an object with provider and model`, { index: i });
    }
    if (typeof m.provider !== "string" || m.provider === "") {
      throw new ConcordError("VALIDATION", `models[${i}].provider must be a non-empty string`, { index: i });
    }
    if (typeof m.model !== "string" || m.model === "") {
      throw new ConcordError("VALIDATION", `models[${i}].model must be a non-empty string`, { index: i });
    }
    if (m.snapshot !== undefined && m.snapshot !== null && typeof m.snapshot !== "string") {
      throw new ConcordError("VALIDATION", `models[${i}].snapshot must be a string when present`, { index: i });
    }
    return { provider: m.provider, model: m.model, snapshot: m.snapshot ?? null };
  });
}

export default [
  {
    method: "GET",
    pattern: "/api/projects/:p/instruments",
    handler: async (req, res, params) => (await loadProject(params.p)).instruments ?? [],
  },
  {
    method: "POST",
    pattern: "/api/projects/:p/instruments",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const body = requireBody(req, ["constructId", "kind", "payload"]);
      findOr404(project.constructs, body.constructId, "construct");
      const instrument = createInstrument(body);
      await updateProject(params.p, (p) => {
        p.instruments.push(instrument);
      });
      await ledger.append(pdirOf(params.p), "human", "instrument.created", {
        instrumentId: instrument.id, constructId: instrument.constructId,
      }, { kind: instrument.kind, name: instrument.name, versionHash: instrument.versionHash });
      return instrument;
    },
  },
  {
    method: "GET",
    pattern: "/api/projects/:p/instruments/:id",
    handler: async (req, res, params) => findOr404((await loadProject(params.p)).instruments, params.id, "instrument"),
  },
  {
    // Re-version: unfrozen instruments mutate in place (level resets to
    // exploratory, stability/silver/certificate drop); frozen instruments fork
    // with lineage. Either way: ledger instrument.versioned.
    method: "PUT",
    pattern: "/api/projects/:p/instruments/:id",
    handler: async (req, res, params) => {
      const body = requireBody(req);
      let result;
      let forked = false;
      await updateProject(params.p, (p) => {
        const i = (p.instruments ?? []).findIndex((x) => x.id === params.id);
        if (i === -1) throw new ConcordError("NOT_FOUND", `instrument '${params.id}' not found`, { id: params.id });
        const inst = p.instruments[i];
        if (body.payload !== undefined) {
          result = versionInstrument(inst, body.payload);
          if (result !== inst) {
            // frozen → fresh fork carrying parentVersion
            forked = true;
            if (body.name) result.name = body.name;
            result.humanTouched = true;
            p.instruments.push(result);
          } else {
            if (body.name) inst.name = body.name;
            inst.humanTouched = true;
          }
        } else if (body.name) {
          if (inst.frozen) throw new ConcordError("VALIDATION", "frozen instruments are immutable — send a payload to fork a new version", {});
          inst.name = body.name;
          inst.humanTouched = true;
          result = inst;
        } else {
          throw new ConcordError("VALIDATION", "instrument update requires a payload or name", {});
        }
      });
      await ledger.append(pdirOf(params.p), "human", "instrument.versioned", {
        instrumentId: result.id,
      }, {
        version: result.version,
        versionHash: result.versionHash,
        ...(forked ? { forkedFrom: params.id, parentVersion: result.parentVersion } : {}),
      });
      return result;
    },
  },
  {
    method: "DELETE",
    pattern: "/api/projects/:p/instruments/:id",
    handler: async (req, res, params) => {
      await updateProject(params.p, (p) => {
        const i = (p.instruments ?? []).findIndex((x) => x.id === params.id);
        if (i === -1) throw new ConcordError("NOT_FOUND", `instrument '${params.id}' not found`, { id: params.id });
        if (p.instruments[i].frozen) {
          throw new ConcordError("VALIDATION", "frozen instruments are part of the evidence record and cannot be deleted", { id: params.id });
        }
        p.instruments.splice(i, 1);
      });
      await ledger.append(pdirOf(params.p), "human", "instrument.deleted", { instrumentId: params.id }, {});
      return { deleted: params.id };
    },
  },
  {
    // Director re-compile → a NEW VERSION of this instrument (judge prompt or
    // dictionary seed). The Director authors; the human triggered it.
    method: "POST",
    pattern: "/api/projects/:p/instruments/:i/compile",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const instrument = findOr404(project.instruments, params.i, "instrument");
      const construct = constructOf(project, instrument);
      const body = req.body ?? {};

      let proposal;
      let note;
      if (instrument.kind === "judge") {
        proposal = await withDirectorSpend(project, () => compileInstrument(project, construct, {
          workerClass: body.workerClass ?? instrument.payload.workerClass ?? "mid",
          provider: body.provider ?? instrument.payload.provider,
          model: body.model ?? instrument.payload.model,
          snapshot: body.snapshot ?? instrument.payload.snapshot ?? null,
        }));
        note = proposal.compileNote;
      } else if (instrument.kind === "dictionary") {
        const units = await corpusUnitsFor(project, body.corpusId).catch(() => []);
        const sample = seededSample(units, Math.min(12, units.length), `dictseed|${instrument.id}`);
        const seeded = await withDirectorSpend(project, () => seedDictionary(project, construct, sample));
        proposal = seeded.instrument;
        note = seeded.instrument.compileNote;
      } else {
        throw new ConcordError("VALIDATION", `compile applies to judge or dictionary instruments, not "${instrument.kind}"`, { kind: instrument.kind });
      }

      let result;
      let forked = false;
      await updateProject(params.p, (p) => {
        const i = p.instruments.findIndex((x) => x.id === params.i);
        if (i === -1) throw new ConcordError("NOT_FOUND", `instrument '${params.i}' vanished`, { id: params.i });
        result = versionInstrument(p.instruments[i], proposal.payload);
        if (result !== p.instruments[i]) {
          forked = true;
          p.instruments.push(result);
        }
      });
      await ledger.append(pdirOf(params.p), "human", "instrument.versioned", { instrumentId: result.id }, {
        via: "director-compile",
        version: result.version,
        versionHash: result.versionHash,
        note: note ?? null,
        ...(forked ? { forkedFrom: params.i } : {}),
      });
      return result;
    },
  },
  {
    // Silver-tune: SSE iterations then done. Real engine + stability modules
    // injected; budget headroom enforced up front and threaded into the loop.
    method: "POST",
    pattern: "/api/projects/:p/instruments/:i/silver-tune",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const instrument = findOr404(project.instruments, params.i, "instrument");
      if (instrument.frozen) {
        throw new ConcordError("VALIDATION", "cannot silver-tune a frozen instrument — fork a new version first", { id: params.i });
      }
      constructOf(project, instrument);
      if (!project.director) {
        throw new ConcordError("CONFIG_MISSING", "silver tuning needs a Director model — set one in Settings", {});
      }
      const body = req.body ?? {};
      const units = await corpusUnitsFor(project, body.corpusId);

      // budget gate BEFORE the stream opens (clean 400), then the remaining
      // headroom becomes the loop's own cap
      const cap = project.budget?.capUSD ?? null;
      const spent = project.budget?.spentUSD ?? 0;
      checkBudget(spent, cap);
      const remaining = cap === null ? null : round6(Math.max(0, cap - spent));

      const conn = sse(res);
      try {
        const result = await silverTune(project, instrument, units, {
          engine: engineMod,          // server/runs/engine.js — the real module
          stability: stabilityMod,    // server/instruments/stability.js — the real module
          ...(body.n !== undefined ? { n: body.n } : {}),
          ...(remaining !== null ? { capUSD: remaining } : {}),
          onIteration: (it) => conn.send("iteration", it),
        });
        await addSpend(params.p, (result.cost?.workerUSD ?? 0) + (result.cost?.directorUSD ?? 0));
        conn.send("done", {
          instrumentId: result.instrument.id,
          level: result.instrument.level,
          versionHash: result.instrument.versionHash,
          stability: result.instrument.stability ?? null,
          curve: result.curve,
          cost: result.cost,
          ...(result.stoppedBy ? { stoppedBy: result.stoppedBy } : {}),
        });
      } catch (err) {
        conn.send("error", { code: err?.code ?? "INTERNAL", message: err?.message ?? String(err) });
      } finally {
        conn.close();
      }
    },
  },
  {
    // Test–retest stability. The module ledgers instrument.stability itself;
    // the route persists the verdict onto the (unfrozen) instrument, writes
    // the per-rerun artifact (stabilityFile) and rolls up the rerun cost.
    //
    // Alternate judges: body.models = [{provider, model, snapshot?}, …] (≤4,
    // judge instruments only) — each labels the SAME sampled units ONCE with
    // the instrument's same compiled prompt/params/schema, persisting beside
    // the reruns as artifact.alts so the reliability matrix can surface
    // model-vs-model agreement WITHOUT minting a new instrument. alpha/pass
    // stay own-model-reruns-only; a failing alternate records {provider,
    // model, error} and never sinks the check.
    method: "POST",
    pattern: "/api/projects/:p/instruments/:i/stability",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const instrument = findOr404(project.instruments, params.i, "instrument");
      const body = req.body ?? {};
      const altModels = validateAltModels(body.models, instrument);
      const corpusId = body.corpusId ?? project.corpora?.[0]?.id ?? null;
      const units = await corpusUnitsFor(project, corpusId);
      const opts = {};
      if (body.k !== undefined) opts.k = body.k;
      if (body.n !== undefined) opts.n = body.n;
      if (altModels) opts.alts = altModels;
      const { alpha, pass, runs, alts } = await stabilityMod.stabilityCheck(project, instrument, units, opts);
      await addSpend(params.p,
        runs.reduce((n, r) => n + (r.cost?.actualUSD ?? 0), 0)
        + (alts ?? []).reduce((n, a) => n + (a.cost?.actualUSD ?? 0), 0));

      // Persist the per-rerun labels so the reliability matrix can read the
      // reruns back as retest:<instrumentId>:<index> sources. Same final-line
      // filter as the stability module's own α data: panels keep only the
      // aggregate verdict; flagged/no-label lines are missing data.
      const finalJuror = instrument.kind === "panel" ? "aggregate" : null;
      const unitIds = [];
      const seenUnits = new Set();
      const reruns = runs.map((run, i) => {
        const labels = {};
        for (const o of run.outputs ?? []) {
          if (finalJuror !== null && o.juror !== finalJuror) continue;
          if (!seenUnits.has(o.unitId)) {
            seenUnits.add(o.unitId);
            unitIds.push(o.unitId);
          }
          if (o.label === undefined || o.flagged) continue;
          labels[o.unitId] = o.label;
        }
        return { index: i + 1, labels };
      });

      // Alternate judges persist beside the reruns (same label filter); the
      // key is omitted entirely when none were requested — byte-compatible
      // with the wave-1 artifact. Errored alternates keep their error.
      let altsOut = null;
      let respAlts = null;
      if (alts) {
        altsOut = [];
        respAlts = [];
        for (const a of alts) {
          if (a.error !== undefined) {
            altsOut.push({ provider: a.provider, model: a.model, error: a.error });
            respAlts.push({ provider: a.provider, model: a.model, error: a.error });
            continue;
          }
          const labels = {};
          for (const o of a.outputs ?? []) {
            if (o.label === undefined || o.flagged) continue;
            labels[o.unitId] = o.label;
          }
          altsOut.push({ provider: a.provider, model: a.model, labels });
          respAlts.push({ provider: a.provider, model: a.model, n: Object.keys(labels).length });
        }
      }

      await writeJsonAtomic(stabilityFile(params.p, instrument.id), {
        id: newId("st"),
        instrumentId: instrument.id,
        constructId: instrument.constructId,
        corpusId,
        k: runs.length,
        n: unitIds.length,
        alpha,
        unitIds,
        reruns,
        ...(altsOut ? { alts: altsOut } : {}),
        createdAt: new Date().toISOString(),
      });

      if (!instrument.frozen) {
        await updateProject(params.p, (p) => {
          const inst = (p.instruments ?? []).find((x) => x.id === params.i);
          if (!inst || inst.frozen) return;
          inst.stability = { alpha, k: opts.k ?? 3, n: Math.min(opts.n ?? 100, 100, units.length), ranAt: new Date().toISOString() };
          if (pass && inst.silver && inst.level === "exploratory") inst.level = "stabilized";
        });
      }
      return { alpha, pass, ...(respAlts ? { alts: respAlts } : {}) };
    },
  },
  {
    // Freeze: mint the certificate. HUMAN AGREEMENT FIRST — a gold set whose
    // humanAgreement was never computed (the agreement route does that, and
    // ledgers goldset.agreement) cannot calibrate an instrument.
    method: "POST",
    pattern: "/api/projects/:p/instruments/:i/freeze",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const instrument = findOr404(project.instruments, params.i, "instrument");
      if (instrument.frozen) throw new ConcordError("VALIDATION", "instrument is already frozen", { id: params.i });
      const construct = constructOf(project, instrument);
      const body = requireBody(req, ["goldsetId"]);
      const goldset = await readGoldset(params.p, body.goldsetId);
      if (goldset.constructId !== instrument.constructId) {
        throw new ConcordError("VALIDATION", "gold set and instrument measure different constructs", {
          goldsetConstruct: goldset.constructId, instrumentConstruct: instrument.constructId,
        });
      }
      if (!goldset.humanAgreement) {
        throw new ConcordError("VALIDATION",
          "human agreement has not been computed for this gold set — run the agreement step first (human reliability is established before any machine comparison)",
          { goldsetId: body.goldsetId });
      }
      const gold = goldLabelMap(goldset);
      if (gold.size === 0) {
        throw new ConcordError("VALIDATION", "the gold set has no adjudicated or consensus labels yet", { goldsetId: body.goldsetId });
      }

      // the machine side: judge the gold units NOW with this instrument
      const units = await unitsById(project, [...gold.keys()], { corpusId: goldset.corpusId });
      if (units.size === 0) {
        throw new ConcordError("VALIDATION", "none of the gold units were found in this project's corpora", {});
      }
      const eph = await engineMod.runEphemeral(project, instrument, [...units.values()]);
      await addSpend(params.p, eph.cost?.actualUSD ?? 0);
      const finals = finalsOf(eph.outputs, instrument);

      const rows = [];
      for (const [unitId, label] of gold) {
        const out = finals.get(unitId);
        if (!out || out.label === undefined) continue;
        rows.push({ unitId, coder: "gold", value: statValue(label) });
        rows.push({ unitId, coder: "machine", value: statValue(out.label) });
      }
      if (rows.length === 0) {
        throw new ConcordError("VALIDATION", "the instrument produced no comparable outputs over the gold units", {});
      }
      const agreement = agreementReport(rows, construct, { goldCoder: "gold", pairCoders: ["gold", "machine"] });

      const certificate = {
        frozenAt: new Date().toISOString(),
        goldsetId: body.goldsetId,
        agreement,
        humanAgreement: goldset.humanAgreement,
        versionHash: instrument.versionHash,
        modelPinned: modelPinnedOf(instrument),
      };

      await updateProject(params.p, (p) => {
        const inst = (p.instruments ?? []).find((x) => x.id === params.i);
        if (!inst) throw new ConcordError("NOT_FOUND", `instrument '${params.i}' vanished`, { id: params.i });
        if (inst.frozen) throw new ConcordError("VALIDATION", "instrument is already frozen", { id: params.i });
        inst.level = "calibrated"; // before freeze(): the object is immutable afterwards
        freezeInstrument(inst, certificate);
      });
      await ledger.append(pdirOf(params.p), "human", "instrument.frozen", {
        instrumentId: params.i, goldsetId: body.goldsetId,
      }, {
        versionHash: certificate.versionHash,
        percent: agreement.percent,
        kappa: agreement.kappa,
        alpha: agreement.alpha,
        n: agreement.n,
        modelPinned: certificate.modelPinned,
      });
      return certificate;
    },
  },
  {
    // Ephemeral preview over supplied unit ids: no run record, no ledger, no
    // outputs file — just the verdicts (cache still applies, so it is cheap).
    method: "POST",
    pattern: "/api/projects/:p/instruments/:i/preview",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const instrument = findOr404(project.instruments, params.i, "instrument");
      const body = requireBody(req, ["unitIds"]);
      if (!Array.isArray(body.unitIds) || body.unitIds.length === 0) {
        throw new ConcordError("VALIDATION", "preview requires a non-empty unitIds array", {});
      }
      const found = await unitsById(project, body.unitIds, { corpusId: body.corpusId });
      if (found.size === 0) throw new ConcordError("NOT_FOUND", "none of the requested units exist in this project", {});
      const result = await engineMod.runEphemeral(project, instrument, [...found.values()]);
      await addSpend(params.p, result.cost?.actualUSD ?? 0);
      // dictionary previews carry the term-hit spans the editor highlights:
      // [{category, term, start, end}] per output (dictionary.hits)
      let outputs = result.outputs;
      if (instrument.kind === "dictionary") {
        outputs = outputs.map((o) => {
          const unit = found.get(o.unitId);
          return unit ? { ...o, hits: dictionaryHits(unit, instrument.payload) } : o;
        });
      }
      return { outputs, cost: result.cost, quarantine: result.quarantine, missing: body.unitIds.filter((id) => !found.has(id)) };
    },
  },
];
