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
import {
  draftConstructs,
  importCodebook,
  inductiveTaxonomy,
  acceptConstructs,
} from "../director/constructs.js";
import { readCorpusUnits, seededSample } from "../director/director.js";
import { findOr404, requireBody, pdirOf, withDirectorSpend } from "./_shared.js";

// "Draft with Director" input: free text that is EITHER newline-separated
// concept names (optionally "name: hint") to formalize, or a single research
// question. A lone line that ends in "?" — or that has no colon and more than
// six words — reads as a question; everything else reads as concepts.
export function parseDraftInput(input) {
  const lines = String(input ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new ConcordError(
      "VALIDATION",
      'draft input is empty — give concept names (one per line, optionally "name: hint") or a research question',
      {},
    );
  }
  if (lines.length === 1) {
    const line = lines[0];
    if (line.endsWith("?") || (!line.includes(":") && line.split(/\s+/).length > 6)) {
      return line; // a question, passed through whole
    }
  }
  return lines.map((line) => {
    const i = line.indexOf(":");
    return i === -1
      ? line
      : { name: line.slice(0, i).trim(), definition: line.slice(i + 1).trim() };
  });
}

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
          throw new ConcordError("VALIDATION", `construct ${construct.id} already exists`, {
            id: construct.id,
          });
        }
        p.constructs.push(construct);
      });
      await ledger.append(
        pdirOf(params.p),
        "human",
        "construct.created",
        { constructId: construct.id },
        {
          name: construct.name,
          type: construct.type,
          authoredBy: construct.authoredBy,
        },
      );
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
      if (!file)
        throw new ConcordError("VALIDATION", "codebook import requires an uploaded file", {});
      const ext = path.extname(file.filename ?? "").toLowerCase();
      const kind = ext === ".docx" ? "docx" : ext === ".pdf" ? "pdf" : null;
      if (!kind) {
        throw new ConcordError(
          "VALIDATION",
          `codebook import supports .docx or .pdf, got "${ext}"`,
          { ext },
        );
      }
      const constructs = await withDirectorSpend(project, () =>
        importCodebook(project, file.buffer, kind),
      );
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
      if (!corpusId)
        throw new ConcordError("VALIDATION", "inductive taxonomy requires a corpus", {});
      return withDirectorSpend(project, () =>
        inductiveTaxonomy(project, corpusId, body.n !== undefined ? { n: body.n } : {}),
      );
    },
  },
  {
    // Draft with Director: formalize MY concepts (or compile MY question)
    // into codebook entries — distinct from /inductive, which proposes themes
    // FROM the corpus. Returns proposals only; /constructs/accept persists.
    method: "POST",
    pattern: "/api/projects/:p/constructs/draft",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const body = requireBody(req, ["input"]);
      const themesOrQuestion = parseDraftInput(body.input);
      const corpusId = body.corpusId ?? project.corpora?.[0]?.id;
      if (!corpusId) {
        throw new ConcordError(
          "VALIDATION",
          "construct drafting requires a corpus to mine worked examples from — import one first",
          {},
        );
      }
      const { units } = await readCorpusUnits(project, corpusId);
      const sample = seededSample(units, Math.min(60, units.length), `draft|${corpusId}`);
      const constructs = await withDirectorSpend(project, () =>
        draftConstructs(project, themesOrQuestion, sample),
      );
      return { constructs, sampleN: sample.length };
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
    handler: async (req, res, params) =>
      findOr404((await loadProject(params.p)).constructs, params.id, "construct"),
  },
  {
    method: "PUT",
    pattern: "/api/projects/:p/constructs/:id",
    handler: async (req, res, params) => {
      const body = requireBody(req);
      let updated;
      await updateProject(params.p, (p) => {
        const i = (p.constructs ?? []).findIndex((c) => c.id === params.id);
        if (i === -1)
          throw new ConcordError("NOT_FOUND", `construct '${params.id}' not found`, {
            id: params.id,
          });
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
      await ledger.append(
        pdirOf(params.p),
        "human",
        "construct.edited",
        { constructId: params.id },
        {
          fields: Object.keys(body),
        },
      );
      return updated;
    },
  },
  {
    method: "DELETE",
    pattern: "/api/projects/:p/constructs/:id",
    handler: async (req, res, params) => {
      await updateProject(params.p, (p) => {
        const i = (p.constructs ?? []).findIndex((c) => c.id === params.id);
        if (i === -1)
          throw new ConcordError("NOT_FOUND", `construct '${params.id}' not found`, {
            id: params.id,
          });
        const dependents = (p.instruments ?? []).filter((inst) => inst.constructId === params.id);
        if (dependents.length > 0) {
          throw new ConcordError(
            "VALIDATION",
            `construct '${params.id}' is measured by ${dependents.length} instrument(s) — delete them first`,
            {
              instruments: dependents.map((d) => d.id),
            },
          );
        }
        p.constructs.splice(i, 1);
      });
      await ledger.append(
        pdirOf(params.p),
        "human",
        "construct.deleted",
        { constructId: params.id },
        {},
      );
      return { deleted: params.id };
    },
  },
];
