// The evidence dossier behind any number: the unit itself, dictionary hits
// per dictionary instrument, every run's outputs for the unit (with juror,
// rationale and escalation provenance), gold labels, and source position.
import { ConcordError } from "../core/errors.js";
import { loadProject } from "../core/store.js";
import { hits as dictHits } from "../instruments/dictionary.js";
import { unitsById, readGoldset, readNdjson, runOutputsFile } from "./_shared.js";

export default [
  {
    method: "GET",
    pattern: "/api/projects/:p/evidence/:unitId",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const found = await unitsById(project, [params.unitId]);
      const unit = found.get(params.unitId);
      if (!unit) {
        throw new ConcordError("NOT_FOUND", `unit '${params.unitId}' not found in any corpus`, { unitId: params.unitId });
      }

      // dictionary hits per dictionary instrument (highlight spans)
      const dictionaryHits = [];
      for (const inst of (project.instruments ?? []).filter((i) => i.kind === "dictionary")) {
        try {
          dictionaryHits.push({
            instrumentId: inst.id,
            name: inst.name,
            versionHash: inst.versionHash,
            hits: dictHits(unit, inst.payload),
          });
        } catch { /* malformed payload → skip, never block the dossier */ }
      }

      // outputs grouped by run
      const outputs = [];
      for (const run of project.runs ?? []) {
        const lines = await readNdjson(runOutputsFile(params.p, run.id), {
          filter: (o) => o.unitId === params.unitId,
        }).catch(() => []);
        if (lines.length === 0) continue;
        outputs.push({
          runId: run.id,
          instrumentId: run.instrumentId,
          status: run.status,
          model: run.model,
          outputs: lines.map((o) => ({
            juror: o.juror,
            label: o.label,
            ...(o.confidence !== undefined ? { confidence: o.confidence } : {}),
            ...(o.rationale !== undefined ? { rationale: o.rationale } : {}),
            ...(o.escalated ? { escalated: true } : {}),
            ...(o.escalatedBy ? { escalatedBy: o.escalatedBy } : {}),
            ...(o.flagged ? { flagged: true } : {}),
            ...(o.entropy !== undefined ? { entropy: o.entropy } : {}),
            ...(o.scores !== undefined ? { scores: o.scores } : {}),
          })),
        });
      }

      // gold labels across every gold set that sampled this unit
      const goldLabels = [];
      for (const meta of project.goldsets ?? []) {
        const gs = await readGoldset(params.p, meta.id).catch(() => null);
        if (!gs || !(gs.sample ?? []).some((s) => s.unitId === params.unitId)) continue;
        const coders = {};
        for (const c of gs.coders ?? []) {
          if (c.labels?.[params.unitId] !== undefined) coders[c.coderId] = c.labels[params.unitId];
        }
        goldLabels.push({
          goldsetId: gs.id,
          tier: gs.tier,
          status: gs.status,
          coders,
          adjudicated: gs.adjudicated?.[params.unitId] ?? null,
        });
      }

      return {
        unit,
        dictionaryHits,
        outputs,
        goldLabels,
        sourcePos: unit.pos ?? null,
      };
    },
  },
];
