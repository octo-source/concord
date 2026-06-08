// The evidence dossier behind any number: the unit itself, dictionary hits
// per dictionary instrument, every run's outputs for the unit (with juror,
// rationale and escalation provenance), gold labels, and source position.
import { ConcordError } from "../core/errors.js";
import { loadProject } from "../core/store.js";
import { hits as dictHits } from "../instruments/dictionary.js";
import { unitsById, readGoldset, readNdjson, runOutputsFile, findOr404 } from "./_shared.js";

export default [
  {
    method: "GET",
    pattern: "/api/projects/:p/evidence/:unitId",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      // Unit ids are content-addressed per corpus (sha256(corpusId|row|text)),
      // so a re-unitized variant column shares NO ids with its parent — but a
      // caller that knows which corpus the number came from (the coding
      // sprint, adjudication) passes ?corpusId so the dossier resolves the
      // unit from THAT corpus's text, never whichever corpus happens to be
      // first. Without it the resolution falls back to a scan of every corpus.
      const corpusId = req.query.corpusId || null;
      if (corpusId) findOr404(project.corpora, corpusId, "corpus");
      const found = await unitsById(project, [params.unitId], corpusId ? { corpusId } : {});
      const unit = found.get(params.unitId);
      if (!unit) {
        throw new ConcordError("NOT_FOUND",
          corpusId
            ? `unit '${params.unitId}' not found in corpus '${corpusId}'`
            : `unit '${params.unitId}' not found in any corpus`,
          { unitId: params.unitId, ...(corpusId ? { corpusId } : {}) });
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
      const warnings = [];
      for (const run of project.runs ?? []) {
        let lines;
        try {
          lines = await readNdjson(runOutputsFile(params.p, run.id), {
            filter: (o) => o.unitId === params.unitId,
          });
        } catch (err) {
          // readNdjson already returns [] for a missing file, so this catch
          // only ever fires on real corruption (BAD_NDJSON mid-file) or a
          // transient I/O fault. Swallowing it silently dropped a unit's
          // outputs from the dossier — intermittently (the "1/240 flake").
          // NOT_FOUND/ENOENT stay benign (no run dir yet); anything else
          // surfaces as a dossier-level warning instead of vanishing.
          if (err?.code === "NOT_FOUND" || err?.code === "ENOENT") continue;
          warnings.push({
            runId: run.id,
            code: err?.code ?? "ERROR",
            message: `could not read outputs for run '${run.id}': ${err?.message ?? String(err)}`,
          });
          continue;
        }
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
            ...(o.repaired ? { repaired: true } : {}), // the inspector's 'repaired' chip reads this
            ...(o.flagged ? { flagged: true } : {}),
            ...(o.entropy !== undefined ? { entropy: o.entropy } : {}),
            ...(o.scores !== undefined ? { scores: o.scores } : {}),
          })),
        });
      }

      // gold labels across every gold set that sampled this unit
      const goldLabels = [];
      for (const meta of project.goldsets ?? []) {
        // readGoldset throws NOT_FOUND for a missing file and CORRUPT for bad
        // JSON. Only the missing case is benign here; a corrupt gold set must
        // not silently drop the whole set from the dossier — surface it.
        let gs;
        try {
          gs = await readGoldset(params.p, meta.id);
        } catch (err) {
          if (err?.code === "NOT_FOUND" || err?.code === "ENOENT") continue;
          warnings.push({
            goldsetId: meta.id,
            code: err?.code ?? "ERROR",
            message: `could not read gold set '${meta.id}': ${err?.message ?? String(err)}`,
          });
          continue;
        }
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
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    },
  },
];
