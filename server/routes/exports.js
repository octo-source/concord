// Exports: the methods section of record (methods.generate — it ledgers
// export.methods itself), the side-effect-free methods PREVIEW (no ledger
// event; what the Reports screen renders on every visit), the replication
// archive (zip stream; module ledgers export.replication; ?goldText=0 ships
// gold labels/π without unit text), and the standalone report HTML (which
// renders methods excerpts through the side-effect-free preview path).
import { ConcordError } from "../core/errors.js";
import { loadProject } from "../core/store.js";
import { generate as generateMethods, generatePreview as generateMethodsPreview } from "../reporting/methods.js";
import { build as buildReplication } from "../reporting/replication.js";
import { render as renderReport } from "../reporting/report.js";
import { pdirOf } from "./_shared.js";

function analysisIdsFrom(req, project, { required = true } = {}) {
  const q = req.query.analyses ?? req.query.analysisId ?? req.query.analysisIds;
  const ids = q
    ? String(q).split(",").map((s) => s.trim()).filter(Boolean)
    : (project.analyses ?? []).map((a) => a.id);
  if (ids.length === 0 && required) {
    throw new ConcordError("VALIDATION", "this project has no analyses yet — create one before exporting", {});
  }
  return ids;
}

export default [
  {
    method: "GET",
    pattern: "/api/projects/:p/exports/methods",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const ids = analysisIdsFrom(req, project);
      // export of record for ONE analysis: the most recent unless specified
      const analysisId = req.query.analysisId ?? ids[ids.length - 1];
      const { markdown, citations } = await generateMethods(project, analysisId, { projectDir: pdirOf(params.p) });
      return { analysisId, markdown, citations };
    },
  },
  {
    // Same prose as the export of record, NO ledger append: screens render
    // this on mount so a visit can never mint an export.methods event.
    method: "GET",
    pattern: "/api/projects/:p/exports/methods/preview",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const ids = analysisIdsFrom(req, project);
      const analysisId = req.query.analysisId ?? ids[ids.length - 1];
      const { markdown, citations } = await generateMethodsPreview(project, analysisId, { projectDir: pdirOf(params.p) });
      return { analysisId, markdown, citations };
    },
  },
  {
    method: "GET",
    pattern: "/api/projects/:p/exports/replication",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const ids = analysisIdsFrom(req, project);
      // gold verbatims ship by default; ?goldText=0 ships labels/π only —
      // the researcher owns the license/PII call, the route owns the wiring
      const includeGoldText = !["0", "false"].includes(String(req.query.goldText ?? "").toLowerCase());
      const { zipBuffer } = await buildReplication(project, ids, { projectDir: pdirOf(params.p), includeGoldText });
      res.writeHead(200, {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${project.slug}-replication.zip"`,
        "content-length": zipBuffer.length,
      });
      res.end(zipBuffer);
    },
  },
  {
    method: "GET",
    pattern: "/api/projects/:p/exports/report",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      let layout;
      if (req.query.layout) {
        try {
          layout = JSON.parse(req.query.layout);
        } catch {
          throw new ConcordError("VALIDATION", "?layout= must be JSON-encoded", {});
        }
      } else if ((project.report?.blocks ?? []).length > 0) {
        // No explicit layout → render the persisted report canvas. The canvas
        // is the researcher's curated layout; the exporter draws exactly it.
        layout = project.report.blocks;
      } else {
        const ids = analysisIdsFrom(req, project);
        layout = [
          { kind: "text", content: `# ${project.name}\n\nConcord evidence report.` },
          ...ids.map((id) => ({ kind: "table", ref: id })),
          // methods excerpt renders through generatePreview (side-effect-free)
          { kind: "methods-excerpt", ref: ids[ids.length - 1] },
        ];
      }
      const html = await renderReport(project, layout, { projectDir: pdirOf(params.p) });
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-disposition": `inline; filename="${project.slug}-report.html"`,
      });
      res.end(html);
    },
  },
];
