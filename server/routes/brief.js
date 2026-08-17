// The Corpus Brief: POST → SSE. Progress stages stream first (sampling →
// prompt-composed → director-called → tick {elapsed} every ~2s during the one
// long call → validating; relayed from generateBrief's onStage), then
// paragraphs as `para` events in order (onParagraph), then `done` carries the
// persisted briefId. brief.generated is ledgered by the module; the route's
// only bookkeeping is the Director-meter cost roll-up.
//
// GET briefs/:bid serves the persisted artifact (briefs/<bid>.json) so a
// stored brief re-renders without re-streaming.
import path from "node:path";
import { ConcordError } from "../core/errors.js";
import { sse } from "../router.js";
import { loadProject } from "../core/store.js";
import { generateBrief } from "../director/brief.js";
import { findOr404, withDirectorSpend, pdirOf, readJsonFile, safeId } from "./_shared.js";

export default [
  {
    method: "GET",
    pattern: "/api/projects/:p/briefs/:bid",
    handler: async (req, res, params) => {
      await loadProject(params.p); // unknown project → 404 before any file read
      safeId(params.bid, "brief"); // never let a traversal id reach the path
      const brief = await readJsonFile(path.join(pdirOf(params.p), "briefs", `${params.bid}.json`));
      if (!brief)
        throw new ConcordError("NOT_FOUND", `brief '${params.bid}' not found`, {
          briefId: params.bid,
        });
      return brief;
    },
  },
  {
    method: "POST",
    pattern: "/api/projects/:p/brief",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const body = req.body ?? {};
      const corpusId = body.corpusId ?? project.corpora?.[0]?.id;
      if (!corpusId)
        throw new ConcordError(
          "VALIDATION",
          "brief requires a corpusId (no corpora on this project)",
          {},
        );
      findOr404(project.corpora, corpusId, "corpus");
      if (!project.director) {
        throw new ConcordError(
          "CONFIG_MISSING",
          "No Director model is configured — set one in Settings before generating a brief",
          {},
        );
      }

      // all 4xx-able validation is done: from here on we stream
      const conn = sse(res);
      // Abort the work when the tab closes mid-stream: generateBrief checks
      // the signal between stages and stops before the one paid Director call,
      // so a disconnect during sampling/prompt composition spends nothing. The
      // in-flight Director call itself is not cancellable (callDirector takes
      // no signal), so a disconnect AFTER the call starts still finishes that
      // one call — the cooperative limit, not a hard kill.
      const ac = new AbortController();
      conn.onClose(() => ac.abort());
      try {
        const brief = await withDirectorSpend(project, () =>
          generateBrief(project, corpusId, {
            signal: ac.signal,
            onStage: (event, data) => conn.send(event, data),
            onParagraph: (para) => conn.send("para", { md: para.md, refs: para.refs }),
          }),
        );
        conn.send("done", {
          briefId: brief.id,
          paragraphs: brief.paragraphs.length,
          themes: brief.themes.length,
          issues: brief.issues,
        });
      } catch (err) {
        // an abort is the expected outcome of a disconnect, not a server fault:
        // the connection is already closed, so conn.send is a no-op — just stop
        if (err?.code !== "ABORTED") {
          conn.send("error", {
            code: err?.code ?? "INTERNAL",
            message: err?.message ?? String(err),
          });
        }
      } finally {
        conn.close();
      }
    },
  },
];
