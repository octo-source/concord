// The Corpus Brief: POST → SSE. Paragraphs stream as `para` events in order
// (relayed straight from generateBrief's onParagraph), then `done` carries the
// persisted briefId. brief.generated is ledgered by the module; the route's
// only bookkeeping is the Director-meter cost roll-up.
import { ConcordError } from "../core/errors.js";
import { sse } from "../router.js";
import { loadProject } from "../core/store.js";
import { generateBrief } from "../director/brief.js";
import { findOr404, withDirectorSpend } from "./_shared.js";

export default [
  {
    method: "POST",
    pattern: "/api/projects/:p/brief",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const body = req.body ?? {};
      const corpusId = body.corpusId ?? project.corpora?.[0]?.id;
      if (!corpusId) throw new ConcordError("VALIDATION", "brief requires a corpusId (no corpora on this project)", {});
      findOr404(project.corpora, corpusId, "corpus");
      if (!project.director) {
        throw new ConcordError("CONFIG_MISSING", "No Director model is configured — set one in Settings before generating a brief", {});
      }

      // all 4xx-able validation is done: from here on we stream
      const conn = sse(res);
      try {
        const brief = await withDirectorSpend(project, () =>
          generateBrief(project, corpusId, {
            onParagraph: (para) => conn.send("para", { md: para.md, refs: para.refs }),
          }));
        conn.send("done", { briefId: brief.id, paragraphs: brief.paragraphs.length, themes: brief.themes.length, issues: brief.issues });
      } catch (err) {
        conn.send("error", { code: err?.code ?? "INTERNAL", message: err?.message ?? String(err) });
      } finally {
        conn.close();
      }
    },
  },
];
