// Projects: list, create, full-graph get, and project-scoped settings (PUT).
import { ConcordError } from "../core/errors.js";
import { createProject } from "../core/objects.js";
import { loadProject, createProjectIfAbsent, listProjects, updateProject } from "../core/store.js";
import * as ledger from "../core/ledger.js";
import { pdirOf, requireBody, validateReportBlock, validateReportBlocks } from "./_shared.js";
import { applyProjectSettings } from "./settings.js";

function summary(p) {
  if (p.corrupt) return { slug: p.slug, corrupt: true };
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    createdAt: p.createdAt,
    privacyMode: p.privacyMode,
    budget: p.budget,
    director: p.director,
    counts: {
      corpora: p.corpora?.length ?? 0,
      constructs: p.constructs?.length ?? 0,
      instruments: p.instruments?.length ?? 0,
      goldsets: p.goldsets?.length ?? 0,
      runs: p.runs?.length ?? 0,
      analyses: p.analyses?.length ?? 0,
      briefs: p.briefs?.length ?? 0,
    },
  };
}

export default [
  {
    method: "GET",
    pattern: "/api/projects",
    handler: async () => (await listProjects()).map(summary),
  },
  {
    method: "POST",
    pattern: "/api/projects",
    handler: async (req) => {
      const body = req.body ?? {};
      const project = createProject({ name: body.name, privacyMode: body.privacyMode, slug: body.slug });
      // Atomic create: the existence check and the write share one per-slug
      // lock inside the store, so two concurrent POSTs with the same slug can
      // never both pass the check and clobber each other — the loser throws
      // CONFLICT (a present-but-corrupt bundle also refuses, never overwrites).
      await createProjectIfAbsent(project);
      await ledger.append(pdirOf(project.slug), "human", "project.created", { projectId: project.id }, {
        name: project.name,
        slug: project.slug,
        privacyMode: project.privacyMode,
      });
      return project;
    },
  },
  {
    method: "GET",
    pattern: "/api/projects/:p",
    handler: async (req, res, params) => loadProject(params.p),
  },
  {
    // Project-scoped settings: {privacyMode?, confirmDowngrade?, budget?:
    // {capUSD}}. The downgrade guard and privacy.mode_changed ledger live in
    // routes/settings.js applyProjectSettings — one helper, one taxonomy.
    method: "PUT",
    pattern: "/api/projects/:p",
    handler: async (req, res, params) => {
      const body = requireBody(req);
      return applyProjectSettings({
        slug: params.p,
        ...(body.privacyMode !== undefined ? { privacyMode: body.privacyMode } : {}),
        ...(body.budget !== undefined ? { budget: body.budget } : {}),
        confirmDowngrade: body.confirmDowngrade,
      });
    },
  },
  {
    // The report canvas is a persisted project artifact. PUT replaces the whole
    // layout (validating kinds, shape and the block budget) and stamps when it
    // changed; the canvas is a researcher's working surface, not a scientific
    // act, so nothing is ledgered.
    method: "PUT",
    pattern: "/api/projects/:p/report",
    handler: async (req, res, params) => {
      const body = requireBody(req, ["blocks"]);
      const blocks = validateReportBlocks(body.blocks);
      let report;
      await updateProject(params.p, (p) => {
        report = { blocks, updatedAt: new Date().toISOString() };
        p.report = report;
      });
      return report;
    },
  },
  {
    // Append one block (the workbench "Add to report" action) → {blocks: n}.
    // The appended block is timestamped so the canvas can show recency.
    method: "POST",
    pattern: "/api/projects/:p/report/blocks",
    handler: async (req, res, params) => {
      const body = requireBody(req, ["block"]);
      const block = validateReportBlock(body.block, "block");
      let count = 0;
      await updateProject(params.p, (p) => {
        const current = p.report ?? { blocks: [], updatedAt: null };
        const blocks = Array.isArray(current.blocks) ? current.blocks : [];
        if (blocks.length >= 100) {
          throw new ConcordError("VALIDATION", "a report holds at most 100 blocks", { count: blocks.length });
        }
        blocks.push({ ...block, addedAt: new Date().toISOString() });
        p.report = { blocks, updatedAt: new Date().toISOString() };
        count = blocks.length;
      });
      return { blocks: count };
    },
  },
];
