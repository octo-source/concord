// Post-run analysis suggestions: dismissible, evidence-linked, never
// auto-executed. The Director sees the run's label distribution, the corpus's
// metadata columns, and a sample of coded units; it proposes crosstab /
// descriptive analyses whose specs must satisfy objects.createAnalysis (a
// suggestion that cannot be materialized is dropped rather than surfaced).
// Evidence refs are filtered to units actually present in the outputs sample.
import path from "node:path";
import { createAnalysis } from "../core/objects.js";
import { readNdjson, projectDir } from "../core/store.js";
import { detect } from "../ingest/mapping.js";
import { callDirector } from "./director.js";
import { analystPrompt, ANALYST_SCHEMA } from "./prompts.js";

// suggestAnalyses(project, run, outputsSample) → [{kind, spec, annotation, evidenceRefs}]
export async function suggestAnalyses(project, run, outputsSample) {
  const instrument = (project.instruments ?? []).find((i) => i.id === run.instrumentId) ?? null;
  const construct = instrument
    ? (project.constructs ?? []).find((c) => c.id === instrument.constructId) ?? null
    : null;

  // label distribution from the sample
  const labelDist = {};
  for (const o of outputsSample ?? []) {
    const key = typeof o.label === "string" ? o.label : JSON.stringify(o.label);
    labelDist[key] = (labelDist[key] ?? 0) + 1;
  }

  // metadata columns + unit texts for evidence context (best effort: a run
  // whose corpus is unreadable still gets distribution-level suggestions)
  let metaColumns = [];
  const unitsById = new Map();
  try {
    const file = path.join(projectDir(project.slug), "corpora", run.corpusId, "units.ndjson");
    const units = await readNdjson(file, { limit: 500 });
    const { columns } = detect(units.map((u) => u.meta ?? {}));
    metaColumns = columns.filter((c) => c.role === "categorical").map((c) => c.name);
    for (const u of units) unitsById.set(u.id, u);
  } catch { /* corpus unreadable → no meta columns */ }

  const { system, user } = analystPrompt({
    construct, run, labelDist, metaColumns, outputsSample: outputsSample ?? [], unitsById,
  });
  const res = await callDirector(project, {
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    schema: ANALYST_SCHEMA,
    // thinking tokens bill against max_tokens on reasoning-class Directors
    // — keep at the reasoning-tolerant floor (≥2048)
    maxTokens: 2048,
  });

  const sampleIds = new Set((outputsSample ?? []).map((o) => o.unitId));
  const suggestions = [];
  for (const s of res.json.suggestions) {
    try {
      createAnalysis({ kind: s.kind, spec: s.spec }); // must be materializable
    } catch {
      continue; // a spec the workbench cannot build is not a suggestion
    }
    suggestions.push({
      kind: s.kind,
      spec: s.spec,
      annotation: s.annotation,
      evidenceRefs: (s.evidenceRefs ?? []).filter((r) => sampleIds.has(r)),
    });
  }
  return suggestions;
}
