// Projects: list, create, full-graph get.
import { ConcordError } from "../core/errors.js";
import { createProject } from "../core/objects.js";
import { loadProject, saveProject, listProjects } from "../core/store.js";
import * as ledger from "../core/ledger.js";
import { pdirOf } from "./_shared.js";

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
      let exists = false;
      try {
        await loadProject(project.slug);
        exists = true;
      } catch (err) {
        if (err.code !== "NOT_FOUND" && err.code !== "CORRUPT") throw err;
        if (err.code === "CORRUPT") exists = true;
      }
      if (exists) {
        throw new ConcordError("VALIDATION", `a project with slug '${project.slug}' already exists`, { slug: project.slug });
      }
      await saveProject(project);
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
];
