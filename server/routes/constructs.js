// Constructs: CRUD + legacy codebook import (docx/pdf → Director proposals) +
// inductive taxonomy + explicit acceptance of Director proposals.
//
// Proposals (import/inductive) are NOT persisted — acceptance is the human
// act, through POST /constructs/accept (acceptConstructs ledgers
// construct.created per construct) or plain POST /constructs.
import path from "node:path";
import { ConcordError } from "../core/errors.js";
import { parseMultipart } from "../router.js";
import { createConstruct } from "../core/objects.js";
import { loadProject, updateProject } from "../core/store.js";
import * as ledger from "../core/ledger.js";
import { importCodebook, inductiveTaxonomy, acceptConstructs } from "../director/constructs.js";
import { findOr404, requireBody, pdirOf, withDirectorSpend } from "./_shared.js";

export default [
  {
    method: "GET",
    pattern: "/api/projects/:p/constructs",
    handler: async (req, res, params) => (await loadProject(params.p)).constructs ?? [],
  },
  {
    method: "POST",
    pattern: "/api/projects/:p/constructs",
    handler: async (req, res, params) => {
      await loadProject(params.p);
      const construct = createConstruct(requireBody(req, ["name", "type"]));
      await updateProject(params.p, (p) => {
        if (p.constructs.some((c) => c.id === construct.id)) {
          throw new ConcordError("VALIDATION", `construct ${construct.id} already exists`, { id: construct.id });
        }
        p.constructs.push(construct);
      });
      await ledger.append(pdirOf(params.p), "human", "construct.created", { constructId: construct.id }, {
        name: construct.name,
        type: construct.type,
        authoredBy: construct.authoredBy,
      });
      return construct;
    },
  },
  {
    method: "POST",
    pattern: "/api/projects/:p/constructs/import",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const { files } = await parseMultipart(req);
      const file = files.find((f) => f.name === "file") ?? files[0];
      if (!file) throw new ConcordError("VALIDATION", "codebook import requires an uploaded file", {});
      const ext = path.extname(file.filename ?? "").toLowerCase();
      const kind = ext === ".docx" ? "docx" : ext === ".pdf" ? "pdf" : null;
      if (!kind) {
        throw new ConcordError("VALIDATION", `codebook import supports .docx or .pdf, got "${ext}"`, { ext });
      }
      const constructs = await withDirectorSpend(project, () => importCodebook(project, file.buffer, kind));
      return { constructs, proposed: true };
    },
  },
  {
    method: "POST",
    pattern: "/api/projects/:p/constructs/inductive",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const body = req.body ?? {};
      const corpusId = body.corpusId ?? project.corpora?.[0]?.id;
      if (!corpusId) throw new ConcordError("VALIDATION", "inductive taxonomy requires a corpus", {});
      return withDirectorSpend(project, () =>
        inductiveTaxonomy(project, corpusId, body.n !== undefined ? { n: body.n } : {}));
    },
  },
  {
    method: "POST",
    pattern: "/api/projects/:p/constructs/accept",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const body = requireBody(req, ["constructs"]);
      const constructIds = await acceptConstructs(project, body.constructs);
      return { constructIds };
    },
  },
  {
    method: "GET",
    pattern: "/api/projects/:p/constructs/:id",
    handler: async (req, res, params) => findOr404((await loadProject(params.p)).constructs, params.id, "construct"),
  },
  {
    method: "PUT",
    pattern: "/api/projects/:p/constructs/:id",
    handler: async (req, res, params) => {
      const body = requireBody(req);
      let updated;
      await updateProject(params.p, (p) => {
        const i = (p.constructs ?? []).findIndex((c) => c.id === params.id);
        if (i === -1) throw new ConcordError("NOT_FOUND", `construct '${params.id}' not found`, { id: params.id });
        const existing = p.constructs[i];
        // re-validate the merged construct; identity + provenance are pinned
        // and an edit through the API is by definition a human touch
        updated = createConstruct({
          ...existing,
          ...body,
          id: existing.id,
          createdAt: existing.createdAt,
          authoredBy: existing.authoredBy,
          humanTouched: true,
        });
        p.constructs[i] = updated;
      });
      await ledger.append(pdirOf(params.p), "human", "construct.edited", { constructId: params.id }, {
        fields: Object.keys(body),
      });
      return updated;
    },
  },
  {
    method: "DELETE",
    pattern: "/api/projects/:p/constructs/:id",
    handler: async (req, res, params) => {
      await updateProject(params.p, (p) => {
        const i = (p.constructs ?? []).findIndex((c) => c.id === params.id);
        if (i === -1) throw new ConcordError("NOT_FOUND", `construct '${params.id}' not found`, { id: params.id });
        const dependents = (p.instruments ?? []).filter((inst) => inst.constructId === params.id);
        if (dependents.length > 0) {
          throw new ConcordError("VALIDATION", `construct '${params.id}' is measured by ${dependents.length} instrument(s) — delete them first`, {
            instruments: dependents.map((d) => d.id),
          });
        }
        p.constructs.splice(i, 1);
      });
      await ledger.append(pdirOf(params.p), "human", "construct.deleted", { constructId: params.id }, {});
      return { deleted: params.id };
    },
  },
];
