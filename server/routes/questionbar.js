// The Question Bar: compile a plain-language question into a visible plan
// (Director call — plan.compiled ledgered by the module), and approve it
// (constructs + instruments materialize via the module, then this route
// preflights a pending run per instrument so the answer reports runIds).
import { ConcordError } from "../core/errors.js";
import { loadProject } from "../core/store.js";
import { compileQuestion, approvePlan } from "../director/questionbar.js";
import { createRun } from "../runs/engine.js";
import { withDirectorSpend, corpusDisplayName } from "./_shared.js";

export default [
  {
    method: "POST",
    pattern: "/api/projects/:p/questionbar",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const body = req.body ?? {};
      const corpusId = body.corpusId ?? project.corpora?.[0]?.id;
      if (!corpusId) {
        throw new ConcordError("VALIDATION", "the question bar needs a corpus — import data first", {});
      }
      const plan = await withDirectorSpend(project, () => compileQuestion(project, corpusId, body.question));
      return { planId: plan.planId, plan };
    },
  },
  {
    method: "POST",
    pattern: "/api/projects/:p/questionbar/:plan/approve",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const approved = await withDirectorSpend(project, () => approvePlan(project, params.plan));

      // materialized instruments → pending runs (preflight estimates + ledger
      // run.preflight land inside engine.createRun); starting them is the
      // researcher's explicit next step
      const fresh = await loadProject(params.p);
      const plan = (fresh.plans ?? []).find((x) => x.planId === params.plan);
      const corpus = (fresh.corpora ?? []).find((c) => c.id === plan.corpusId);
      const corpusName = corpusDisplayName(corpus);
      const runIds = [];
      for (const instrumentId of approved.instrumentIds) {
        const instrument = (fresh.instruments ?? []).find((i) => i.id === instrumentId);
        const name = instrument ? `${instrument.name} · ${corpusName}` : undefined;
        const run = await createRun(fresh, { instrumentId, corpusId: plan.corpusId, ...(name ? { name } : {}) });
        runIds.push(run.id);
      }
      return { ...approved, runIds };
    },
  },
];
